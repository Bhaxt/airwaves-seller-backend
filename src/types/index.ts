export interface User {
  id: string;
  email: string;
  created_at: Date;
  last_login_at: Date | null;
  deleted_at: Date | null;
}

export interface Session {
  id: string;
  user_id: string;
  refresh_token_hash: string;
  expires_at: Date;
  revoked_at: Date | null;
}

export interface Subscription {
  id: string;
  user_id: string;
  stripe_subscription_id: string;
  stripe_price_id: string;
  tier: string;
  status: SubscriptionStatus;
  current_period_end: Date;
  cancel_at_period_end: boolean;
  grace_until: Date | null;
  metadata: Record<string, unknown>;
}

export type SubscriptionStatus =
  | 'trialing' | 'active' | 'past_due' | 'canceled'
  | 'unpaid' | 'incomplete' | 'incomplete_expired' | 'paused';

export interface License {
  id: string;
  user_id: string;
  subscription_id: string | null;
  device_id: string;
  last_jwt_issued_at: Date | null;
  last_seen_at: Date | null;
  revoked_at: Date | null;
}

export interface AuthTokenPair {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: { id: string; email: string; tier: string; features: string[] };
  }
  interface FastifyInstance {
    authenticate: (request: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => Promise<void>;
    db: import('postgres').Sql;
  }
}
