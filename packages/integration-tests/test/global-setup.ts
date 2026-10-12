/**
 * Global Setup - Starts a single PostgreSQL container and pushes the schema once
 * for the whole integration test run, then hands the database URL to every spec
 * file through Vitest's provide/inject channel.
 *
 * Vitest's `hookTimeout` does not apply here (globalSetup is not a hook and is
 * awaited without any timeout), so both infrastructure steps below bound
 * themselves explicitly instead of relying on the test config.
 */

import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

const Filename = fileURLToPath(import.meta.url);
const Dirname = dirname(Filename);

// Bounds image pull + container start + readiness wait together: testcontainers'
// `withStartupTimeout` only bounds the readiness wait, not a slow or stuck image pull.
const CONTAINER_START_TIMEOUT_MS = 120_000;
// The schema push itself is small; this is a generous margin.
const DB_PUSH_TIMEOUT_MS = 60_000;

let container: StartedPostgreSqlContainer | undefined;

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

/** Races a promise against a timeout that rejects with a message naming the step and duration. */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, step: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`[Global Setup] ${step} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export async function setup({ provide }: TestProject) {
  console.log('[Global Setup] Starting PostgreSQL container...');
  const startPromise = new PostgreSqlContainer('postgres:16-alpine').withExposedPorts(5432).start();
  try {
    container = await withTimeout(startPromise, CONTAINER_START_TIMEOUT_MS, 'PostgreSQL container start');
  } catch (error) {
    // Best-effort cleanup if the container ends up starting after we gave up waiting on it.
    startPromise.then((startedContainer) => startedContainer.stop()).catch(() => {});
    throw error;
  }

  const databaseUrl = container.getConnectionUri();
  console.log('[Global Setup] PostgreSQL container started');

  const databasePackagePath = join(Dirname, '..', '..', 'database');
  const schemaPath = join(databasePackagePath, 'prisma', 'schema.prisma');

  console.log('[Global Setup] Pushing Prisma schema...');
  try {
    execSync(`npx prisma db push --schema=${schemaPath}`, {
      cwd: databasePackagePath,
      stdio: 'inherit',
      env: { ...process.env, DATABASE_URL: databaseUrl },
      timeout: DB_PUSH_TIMEOUT_MS,
    });
  } catch (error) {
    const isTimeout = isErrnoException(error) && error.code === 'ETIMEDOUT';
    const message = isTimeout
      ? `[Global Setup] prisma db push timed out after ${DB_PUSH_TIMEOUT_MS}ms`
      : '[Global Setup] db push failed';
    console.error(message, error);
    await container.stop();
    throw isTimeout ? new Error(message, { cause: error }) : error;
  }

  provide('databaseUrl', databaseUrl);
  console.log('[Global Setup] Test database setup complete');
}

export async function teardown() {
  if (!container) {
    return;
  }

  console.log('[Global Teardown] Stopping PostgreSQL container...');
  try {
    await container.stop();
    console.log('[Global Teardown] PostgreSQL container stopped');
  } catch (error) {
    console.error('[Global Teardown] Error stopping container:', error);
  }
}
