/**
 * Debug loggers of the nested-write handling, using the `debug` package
 *
 * Enable them with the DEBUG environment variable:
 *
 * ```bash
 * DEBUG=prisma-audit:* node app.js
 * DEBUG=prisma-audit:nested npm test
 * DEBUG=prisma-audit:prefetch npm run dev
 * ```
 */

import type { Debugger } from 'debug';
import debug from 'debug';

/**
 * Debug logger for nested operations
 */
export const nestedLog: Debugger = debug('prisma-audit:nested');

/**
 * Debug logger for pre-fetch operations
 */
export const preFetchLog: Debugger = debug('prisma-audit:prefetch');
