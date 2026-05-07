import Stripe from 'stripe';
import { config } from '../config.js';
import { db } from '../db/client.js';
import { tierFromLookupKey, TIERS } from './tier-map.js';
import { sendDunningEmail, sendTrialEndingEmail } from './email-service.js';
import { logger } from '../lib/logger.js';

/** Stripe price ID for the Tier 3 / Pro Plus reseller catalog plan ($150/mo). */
const TIER_3_PRICE_ID = 'price_1TS844FbOv6MHXgUYP35NVJz';

export const stripe = new Stripe(config.STRIPE_SECRET_KEY, { apiVersion: '2024-04-10' });

export async function getOrCreateStripeCustomer(userId: string, email: string): Promise<string> {
  const existing = await db`
    SELECT stripe_customer_id FROM stripe_customers WHERE user_id = ${userId}
  `;
  if (existing.length > 0) return existing[0].stripe_customer_id;

  const customer = await stripe.customers.create({ email, metadata: { userId } });
  await db`
    INSERT INTO stripe_customers (user_id, stripe_customer_id) VALUES (${userId}, ${customer.id})
  `;
  return customer.id;
}

export async function createCheckoutSession(opts: {
  userId: string;
  email: string;
  priceId: string;
  successUrl: string;
  cancelUrl: string;
}): Promise<string> {
  const customerId = await getOrCreateStripeCustomer(opts.userId, opts.email);

  let tierDescription = 'Airwaves Subscription';
  for (const [tierKey, tierData] of Object.entries(TIERS)) {
    if ((tierData.stripePriceIds as readonly string[]).includes(opts.priceId)) {
      if (tierKey === 'basic') tierDescription = 'Airwaves Basic';
      else if (tierKey === 'pro') tierDescription = 'Airwaves Pro';
      else if (tierKey === 'pro_plus') tierDescription = 'Airwaves Pro Plus';
      break;
    }
  }

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: 'subscription',
    line_items: [{ price: opts.priceId, quantity: 1 }],
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
    allow_promotion_codes: true,
    customer_update: { name: 'auto', address: 'auto' },
    subscription_data: { description: tierDescription },
    metadata: { userId: opts.userId },
  });
  return session.url!;
}

export async function createPortalSession(userId: string, returnUrl: string): Promise<string> {
  const customers = await db`SELECT stripe_customer_id FROM stripe_customers WHERE user_id = ${userId}`;
  if (customers.length === 0) throw new Error('No Stripe customer found');

  const session = await stripe.billingPortal.sessions.create({
    customer: customers[0].stripe_customer_id,
    return_url: returnUrl,
  });
  return session.url;
}

export async function handleWebhookEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      if (!session.customer) break;
      const customerId = typeof session.customer === 'string' ? session.customer : session.customer.id;

      // Resolve email: prefer session.customer_details, fall back to fetching the customer object.
      let email = session.customer_details?.email ?? null;
      if (!email) {
        try {
          const customer = await stripe.customers.retrieve(customerId) as Stripe.Customer;
          email = customer.email ?? null;
        } catch (err) {
          logger.warn({ err, customerId }, 'checkout.session.completed: failed to retrieve customer email');
        }
      }
      if (!email) {
        logger.warn({ customerId }, 'checkout.session.completed: no email found — cannot provision user');
        break;
      }

      // If this checkout was for Tier 3, we need the resolved subscription/tier
      // BEFORE opening the transaction so the network call can't hold a tx open.
      const subId = typeof session.subscription === 'string'
        ? session.subscription
        : (session.subscription as Stripe.Subscription | null)?.id ?? null;

      let resolvedSub: { sub: Stripe.Subscription; priceId: string; tier: string } | null = null;
      if (subId) {
        try {
          const sub = await stripe.subscriptions.retrieve(subId);
          const priceId = sub.items.data[0]?.price.id ?? '';
          if (priceId === TIER_3_PRICE_ID) {
            let lookupKey = sub.items.data[0]?.price.lookup_key ?? '';
            if (!lookupKey) {
              try {
                const price = await stripe.prices.retrieve(priceId);
                lookupKey = price.lookup_key ?? '';
              } catch (_e) { /* non-fatal */ }
            }
            const tier = lookupKey ? tierFromLookupKey(lookupKey) : 'pro_plus';
            resolvedSub = { sub, priceId, tier };
          }
        } catch (err) {
          logger.warn({ err, subId }, 'checkout.session.completed: failed to retrieve subscription for Tier 3 grant');
        }
      }

      // Atomic: user upsert + customer link + subscription grant + audit + license-version
      // bump must all persist together or not at all. If any fails, Stripe retries.
      await db.begin(async (sql) => {
        const userRows = await sql`
          INSERT INTO users (email) VALUES (${email})
          ON CONFLICT (email) DO UPDATE SET deleted_at = NULL
          RETURNING id
        `;
        const userId = userRows[0].id;

        await sql`
          INSERT INTO stripe_customers (user_id, stripe_customer_id)
          VALUES (${userId}, ${customerId})
          ON CONFLICT (user_id) DO NOTHING
        `;

        if (resolvedSub) {
          const { sub, priceId, tier } = resolvedSub;
          await sql`
            INSERT INTO subscriptions (
              user_id, stripe_subscription_id, stripe_price_id, tier, status,
              current_period_end, cancel_at_period_end
            ) VALUES (
              ${userId}, ${sub.id}, ${priceId}, ${tier},
              ${sub.status as string}, ${new Date(sub.current_period_end * 1000)},
              ${sub.cancel_at_period_end}
            )
            ON CONFLICT (stripe_subscription_id) DO UPDATE SET
              tier = ${tier},
              status = ${sub.status as string},
              current_period_end = ${new Date(sub.current_period_end * 1000)},
              cancel_at_period_end = ${sub.cancel_at_period_end},
              updated_at = now()
          `;
          logger.info({ userId, email, tier, subId: sub.id }, 'Tier 3 checkout: pro_plus license granted');
        }

        await sql`
          INSERT INTO audit_log (user_id, action, subject)
          VALUES (${userId}, 'subscription.checkout_completed', ${customerId})
        `;

        // Bump per-user license_version so the extension picks up the new
        // subscription within ~60s (heartbeat poll) instead of waiting for
        // the 6h JWT to expire.
        await sql`
          UPDATE users SET license_version = license_version + 1 WHERE id = ${userId}
        `;
      });
      break;
    }

    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const sub = event.data.object as Stripe.Subscription;
      const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
      const customers = await db`SELECT user_id FROM stripe_customers WHERE stripe_customer_id = ${customerId}`;
      if (customers.length === 0) break;
      const userId = customers[0].user_id;

      const priceItem = sub.items.data[0];
      const currentPriceId = priceItem.price.id;
      let lookupKey = priceItem.price.lookup_key ?? '';
      if (!lookupKey) {
        try {
          const price = await stripe.prices.retrieve(currentPriceId);
          lookupKey = price.lookup_key ?? '';
        } catch (err) {
          logger.warn({ err }, 'Failed to retrieve price for lookup_key');
        }
      }
      const tier = tierFromLookupKey(lookupKey);

      // Atomic: subscription upsert + audit log entries + license-version bump
      // must commit together.
      await db.begin(async (sql) => {
        await sql`
          INSERT INTO subscriptions (
            user_id, stripe_subscription_id, stripe_price_id, tier, status,
            current_period_end, cancel_at_period_end
          ) VALUES (
            ${userId}, ${sub.id}, ${currentPriceId}, ${tier},
            ${sub.status as string}, ${new Date(sub.current_period_end * 1000)},
            ${sub.cancel_at_period_end}
          )
          ON CONFLICT (stripe_subscription_id) DO UPDATE SET
            tier = ${tier},
            status = ${sub.status as string},
            current_period_end = ${new Date(sub.current_period_end * 1000)},
            cancel_at_period_end = ${sub.cancel_at_period_end},
            updated_at = now()
        `;

        // Tier 3-specific grant/revoke logging for mid-cycle plan changes.
        if (event.type === 'customer.subscription.updated') {
          const prevAttributes = (event.data as Stripe.Event.Data).previous_attributes as Record<string, unknown> | undefined;
          const prevItems = prevAttributes?.items as { data?: Array<{ price: { id: string } }> } | undefined;
          const prevPriceId = prevItems?.data?.[0]?.price?.id ?? null;

          const isNowTier3 = currentPriceId === TIER_3_PRICE_ID && sub.status === 'active';
          const wasTier3 = prevPriceId === TIER_3_PRICE_ID;
          const isNowInactive = ['canceled', 'past_due', 'unpaid'].includes(sub.status);

          if (isNowTier3 && !wasTier3) {
            logger.info({ userId, subId: sub.id, tier }, 'Tier 3 upgrade: pro_plus license granted');
          } else if (wasTier3 && !isNowTier3 && isNowInactive) {
            await sql`
              INSERT INTO audit_log (user_id, action, subject, metadata)
              VALUES (${userId}, 'subscription.tier3_revoked', ${sub.id},
                ${sql.json({ reason: 'subscription_updated', status: sub.status, previousTier: 'pro_plus' })})
            `;
            logger.info({ userId, subId: sub.id, status: sub.status }, 'Tier 3 downgrade/lapse: pro_plus license revoked');
          }
        }

        const action = 'subscription.' + event.type.split('.').pop();
        await sql`
          INSERT INTO audit_log (user_id, action, subject, metadata)
          VALUES (${userId}, ${action}, ${sub.id},
            ${sql.json({ tier, status: sub.status })})
        `;

        // Bump per-user license_version so the extension picks up the
        // tier/status change within ~60s on next heartbeat.
        await sql`
          UPDATE users SET license_version = license_version + 1 WHERE id = ${userId}
        `;
      });
      break;
    }

    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription;
      const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;

      // Atomic: subscription cancel + license revoke + audit + license-version
      // bump must commit together so the extension can never see "subscription
      // canceled but license still valid".
      await db.begin(async (sql) => {
        await sql`
          UPDATE subscriptions SET status = 'canceled', updated_at = now()
          WHERE stripe_subscription_id = ${sub.id}
        `;

        const customers = await sql`SELECT user_id FROM stripe_customers WHERE stripe_customer_id = ${customerId}`;
        if (customers.length > 0) {
          const userId = customers[0].user_id as string;
          await sql`UPDATE licenses SET revoked_at = now() WHERE user_id = ${userId} AND revoked_at IS NULL`;
          await sql`
            INSERT INTO audit_log (user_id, action, subject, metadata)
            VALUES (${userId}, 'subscription.deleted', ${sub.id},
              ${sql.json({ reason: 'stripe_subscription_deleted' })})
          `;
          // Bump per-user license_version so the extension picks up the
          // revocation within ~60s on next heartbeat.
          await sql`
            UPDATE users SET license_version = license_version + 1 WHERE id = ${userId}
          `;
          logger.info({ userId, subId: sub.id }, 'Stripe subscription deleted — licenses revoked');
        }
      });
      break;
    }

    case 'invoice.payment_failed': {
      const invoice = event.data.object as Stripe.Invoice;
      const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer!.id;
      const subId = typeof invoice.subscription === 'string' ? invoice.subscription : invoice.subscription?.id;
      if (!subId) break;

      const graceUntil = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      await db`
        UPDATE subscriptions SET status = 'past_due', grace_until = ${graceUntil}, updated_at = now()
        WHERE stripe_subscription_id = ${subId}
      `;

      const customers = await db`SELECT user_id FROM stripe_customers WHERE stripe_customer_id = ${customerId}`;
      if (customers.length > 0) {
        const users = await db`SELECT email FROM users WHERE id = ${customers[0].user_id}`;
        if (users.length > 0) {
          await sendDunningEmail({ to: users[0].email, gracePeriodEnd: graceUntil }).catch(err =>
            logger.error({ err }, 'Failed to send dunning email')
          );
        }
      }
      break;
    }

    case 'invoice.payment_succeeded': {
      const invoice = event.data.object as Stripe.Invoice;
      const subId = typeof invoice.subscription === 'string' ? invoice.subscription : invoice.subscription?.id;
      if (!subId) break;
      await db`
        UPDATE subscriptions SET status = 'active', grace_until = NULL, updated_at = now()
        WHERE stripe_subscription_id = ${subId}
      `;
      break;
    }

    case 'customer.subscription.trial_will_end': {
      const sub = event.data.object as Stripe.Subscription;
      const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
      const customers = await db`SELECT user_id FROM stripe_customers WHERE stripe_customer_id = ${customerId}`;
      if (customers.length === 0) break;
      const users = await db`SELECT email FROM users WHERE id = ${customers[0].user_id}`;
      if (users.length === 0) break;
      await sendTrialEndingEmail({
        to: users[0].email,
        trialEnd: new Date(sub.trial_end! * 1000),
      }).catch(err => logger.error({ err }, 'Failed to send trial ending email'));
      break;
    }

    default:
      logger.debug({ type: event.type }, 'Unhandled webhook event');
  }
}
