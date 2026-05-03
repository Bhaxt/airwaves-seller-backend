import Stripe from 'stripe';
import { config } from '../config.js';
import { db } from '../db/client.js';
import { tierFromLookupKey, TIERS } from './tier-map.js';
import { sendDunningEmail, sendTrialEndingEmail } from './email-service.js';
import { logger } from '../lib/logger.js';

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
      if (!session.customer || !session.customer_details?.email) break;
      const email = session.customer_details.email;
      const users = await db`SELECT id FROM users WHERE email = ${email} AND deleted_at IS NULL`;
      if (users.length === 0) break;
      const userId = users[0].id;
      const customerId = typeof session.customer === 'string' ? session.customer : session.customer.id;
      await db`
        INSERT INTO stripe_customers (user_id, stripe_customer_id)
        VALUES (${userId}, ${customerId})
        ON CONFLICT (user_id) DO NOTHING
      `;
      await db`
        INSERT INTO audit_log (user_id, action, subject)
        VALUES (${userId}, 'subscription.checkout_completed', ${customerId})
      `;
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
      let lookupKey = priceItem.price.lookup_key ?? '';
      if (!lookupKey) {
        try {
          const price = await stripe.prices.retrieve(priceItem.price.id);
          lookupKey = price.lookup_key ?? '';
        } catch (err) {
          logger.warn({ err }, 'Failed to retrieve price for lookup_key');
        }
      }
      const tier = tierFromLookupKey(lookupKey);

      await db`
        INSERT INTO subscriptions (
          user_id, stripe_subscription_id, stripe_price_id, tier, status,
          current_period_end, cancel_at_period_end
        ) VALUES (
          ${userId}, ${sub.id}, ${priceItem.price.id}, ${tier},
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

      const action = 'subscription.' + event.type.split('.').pop();
      await db`
        INSERT INTO audit_log (user_id, action, subject, metadata)
        VALUES (${userId}, ${action}, ${sub.id},
          ${db.json({ tier, status: sub.status })})
      `;
      break;
    }

    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription;
      await db`
        UPDATE subscriptions SET status = 'canceled', updated_at = now()
        WHERE stripe_subscription_id = ${sub.id}
      `;
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
