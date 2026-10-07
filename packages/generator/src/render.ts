/**
 * Audit schema rendering
 *
 * Turns an audit schema into the text of the three files the generator writes. The text depends on
 * the schema alone: no timestamp, no Prisma version, so the same schema renders the same bytes.
 *
 * @module render
 */

import type { AuditSchema } from '@kuruwic/prisma-audit';

export interface AuditSchemaFiles {
  readonly 'index.js': string;
  readonly 'index.d.ts': string;
  readonly 'package.json': string;
}

const renderModelNameUnion = (schema: AuditSchema): string =>
  schema.models.length === 0 ? 'never' : schema.models.map((model) => `'${model.name}'`).join(' | ');

/**
 * The files of the generator's output directory.
 *
 * `package.json` declares the directory an ES module: it sits inside the user's project, whose own
 * `type` may be CommonJS, and Node would otherwise parse `index.js` as CommonJS.
 */
export const renderAuditSchemaFiles = (schema: AuditSchema): AuditSchemaFiles => ({
  'index.js': `export const auditSchema = ${JSON.stringify(schema, null, 2)};\n`,
  'index.d.ts': [
    "import type { AuditSchema } from '@kuruwic/prisma-audit';",
    '',
    `export type AuditModelName = ${renderModelNameUnion(schema)};`,
    'export declare const auditSchema: AuditSchema<AuditModelName>;',
    '',
  ].join('\n'),
  'package.json': `${JSON.stringify({ type: 'module' }, null, 2)}\n`,
});
