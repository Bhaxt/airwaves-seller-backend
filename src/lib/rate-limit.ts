import { tooManyRequests } from './errors.js';

interface Bucket { count: number; resetAt: number }
const buckets = new Map<string, Bucket>();

export function checkAuthRateLimit(email: string): void {
  const now = Date.now();
  const key = email.toLowerCase();
  let bucket = buckets.get(key);
  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + 15 * 60 * 1000 };
  }
  bucket.count++;
  buckets.set(key, bucket);
  if (bucket.count > 5) {
    throw tooManyRequests('Too many login attempts — try again in 15 minutes');
  }
}

export function _resetRateLimits(): void {
  buckets.clear();
}
