import { timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

export function checkAdminSecret(provided: string | string[] | undefined): boolean {
  if (typeof provided !== 'string') return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(config.ADMIN_SECRET);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
