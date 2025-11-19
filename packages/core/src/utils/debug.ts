/**
 * Debug logging utilities using the `debug` package
 *
 * Enable logging by setting the DEBUG environment variable.
 *
 * @example Environment variable configuration
 * ```bash
 * # Enable all audit logs
 * DEBUG=prisma-audit:* node app.js
 *
 * # Enable specific namespaces
 * DEBUG=prisma-audit:nested npm test
 * DEBUG=prisma-audit:core npm start
 * DEBUG=prisma-audit:prefetch npm run dev
 * ```
 *
 * @example Using debug loggers
 * ```typescript
 * import { nestedLog, coreLog } from './debug.js';
 *
 * nestedLog('Processing nested operation: %s', operation);
 * coreLog('Writing audit log for entity: %s', entityId);
 * ```
 */

import type { Debugger } from 'debug';
import debug from 'debug';

/**
 * Debug logger for nested operations
 */
export const nestedLog: Debugger = debug('prisma-audit:nested');

/**
 * Debug logger for core audit operations
 */
export const coreLog: Debugger = debug('prisma-audit:core');

/**
 * Debug logger for pre-fetch operations
 */
export const preFetchLog: Debugger = debug('prisma-audit:prefetch');
