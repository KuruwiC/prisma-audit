/**
 * Hono Server Entry Point
 */

import { serve } from '@hono/node-server';
import { createApp } from './app.js';

// Set default DATABASE_URL if not provided (for easy example usage)
// Can be overridden by environment variable (e.g., in tests with testcontainers)
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'file:./dev.db?journal_mode=WAL&busy_timeout=5000';
}

const app = createApp();
const port = Number(process.env.PORT) || 3000;

console.log(`🚀 Hono server starting on http://localhost:${port}`);
console.log('📝 Audit logging enabled');

serve({
  fetch: app.fetch,
  port,
});
