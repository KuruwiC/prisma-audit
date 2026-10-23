import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { prisma } from './prisma.js';
import { seedDemo } from './seed.js';

if ((await prisma.user.count()) === 0) {
  await seedDemo();
  console.log('Seeded the demo data');
}

const port = Number(process.env.PORT) || 3000;
serve({ fetch: createApp().fetch, port });
console.log(`Demo API listening on http://localhost:${port}/api`);
