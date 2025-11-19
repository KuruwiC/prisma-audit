/**
 * Global Setup - Sets up DATABASE_URL before test files are imported
 */

import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

const Filename = fileURLToPath(import.meta.url);
const Dirname = dirname(Filename);

declare global {
  var __TEST_DATABASE_URL__: string | undefined;
  var __testContainer__: StartedPostgreSqlContainer | undefined;
}

let container: StartedPostgreSqlContainer;

export async function setup() {
  console.log('[Global Setup] Starting PostgreSQL container...');

  container = await new PostgreSqlContainer('postgres:16-alpine').withExposedPorts(5432).start();

  const databaseUrl = container.getConnectionUri();
  console.log('[Global Setup] PostgreSQL container started');

  process.env.DATABASE_URL = databaseUrl;
  globalThis.__TEST_DATABASE_URL__ = databaseUrl;
  console.log('[Global Setup] Running Prisma migrations...');
  const databasePackagePath = join(Dirname, '..', '..', '..', 'packages', 'database');
  const schemaPath = join(databasePackagePath, 'prisma', 'schema.prisma');

  try {
    execSync(`npx prisma db push --schema=${schemaPath} --skip-generate`, {
      cwd: databasePackagePath,
      stdio: 'inherit',
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });
  } catch (error) {
    console.error('[Global Setup] Migration failed:', error);
    await container.stop();
    throw error;
  }

  console.log('[Global Setup] Generating Prisma Client...');
  try {
    execSync(`npx prisma generate --schema=${schemaPath}`, {
      cwd: databasePackagePath,
      stdio: 'inherit',
    });
  } catch (error) {
    console.error('[Global Setup] Client generation failed:', error);
    await container.stop();
    throw error;
  }

  console.log('[Global Setup] Test database setup complete');
  globalThis.__testContainer__ = container;
}

export async function teardown() {
  console.log('[Global Teardown] Stopping PostgreSQL container...');
  const container = globalThis.__testContainer__;

  if (container) {
    try {
      await container.stop();
      console.log('[Global Teardown] PostgreSQL container stopped');
    } catch (error) {
      console.error('[Global Teardown] Error stopping container:', error);
    }
  }
}
