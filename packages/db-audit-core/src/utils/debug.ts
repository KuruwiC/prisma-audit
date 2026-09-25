/**
 * Debug logger of the core, using the `debug` package
 *
 * Enable it with the DEBUG environment variable:
 *
 * ```bash
 * DEBUG=prisma-audit:core npm start
 * ```
 */

import type { Debugger } from 'debug';
import debug from 'debug';

/**
 * Debug logger for core audit operations
 */
export const coreLog: Debugger = debug('prisma-audit:core');
