import postgres from 'postgres';
import { config } from '../config.js';

export const db = postgres(config.DATABASE_URL, {
  max: 10,
  idle_timeout: 30,
  connect_timeout: 10,
});
