import { Resend } from 'resend';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

const resend = new Resend(config.RESEND_API_KEY);
const FROM = 'AirWaves Seller <onboarding@resend.dev>';

export async function sendMagicLink(opts: {
  to: string;
  token: string;
  code: string;
  clientType?: string;
}): Promise<void> {
  const url = `${config.PUBLIC_URL}/auth/verify?token=${opts.token}&client=${opts.clientType ?? 'ext'}`;
  // Format code as "123 456" for readability
  const prettyCode = `${opts.code.slice(0, 3)} ${opts.code.slice(3)}`;

  await resend.emails.send({
    from: FROM,
    to: opts.to,
    subject: `Your AirWaves Seller code: ${prettyCode}`,
    html: `
      <div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:480px;margin:0 auto;padding:24px;background:#0c0c0c;color:#f0f0f0;border-radius:12px">
        <h2 style="margin:0 0 8px;font-size:18px">Sign in to AirWaves Seller</h2>
        <p style="margin:0 0 20px;color:#b0b0b0;font-size:14px">
          Paste this code into the extension to sign in. It expires in 15 minutes.
        </p>
        <div style="background:#1a1a1a;border:1px solid #333;border-radius:8px;padding:20px;text-align:center;margin-bottom:20px">
          <div style="font-family:'SF Mono',Menlo,monospace;font-size:32px;font-weight:700;letter-spacing:8px;color:#ff2d55">
            ${prettyCode}
          </div>
        </div>
        <p style="margin:0 0 8px;color:#888;font-size:13px">
          Or, if you're on a desktop browser, click this link:
        </p>
        <p style="margin:0 0 24px"><a href="${url}" style="color:#3b82f6">Sign in to AirWaves Seller</a></p>
        <p style="margin:0;color:#666;font-size:12px">
          If you didn't request this, you can safely ignore this email.
        </p>
      </div>
    `,
  });
  logger.info({ to: opts.to }, 'magic link sent');
}

export async function sendDunningEmail(opts: {
  to: string;
  gracePeriodEnd: Date;
}): Promise<void> {
  const days = Math.ceil((opts.gracePeriodEnd.getTime() - Date.now()) / 86400000);
  await resend.emails.send({
    from: FROM,
    to: opts.to,
    subject: 'Action required — payment failed for AirWaves Seller',
    html: `
      <p>Your last payment for AirWaves Seller failed.</p>
      <p>You have <strong>${days} day${days !== 1 ? 's' : ''}</strong> to update your payment method before your access is paused.</p>
      <p><a href="${config.PUBLIC_URL}/billing/portal">Update payment method</a></p>
    `,
  });
}

export async function sendTrialEndingEmail(opts: {
  to: string;
  trialEnd: Date;
}): Promise<void> {
  await resend.emails.send({
    from: FROM,
    to: opts.to,
    subject: 'Your AirWaves Seller trial ends in 7 days',
    html: `
      <p>Your free trial ends on <strong>${opts.trialEnd.toDateString()}</strong>.</p>
      <p>Subscribe now to keep access to all features.</p>
      <p><a href="${config.PUBLIC_URL}/pricing">View plans</a></p>
    `,
  });
}
