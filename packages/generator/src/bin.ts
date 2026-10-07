/**
 * The `prisma-audit-generator` executable.
 *
 * Prisma starts it for each `generator` block whose provider is `prisma-audit-generator`, and the
 * block's `output` receives the audit schema files.
 *
 * @module bin
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import generatorHelper from '@prisma/generator-helper';
import { renderAuditSchemaFiles } from './render.js';
import { toAuditSchema } from './to-audit-schema.js';

const { generatorHandler } = generatorHelper;

generatorHandler({
  onManifest: () => ({ prettyName: 'prisma-audit' }),
  onGenerate: async (options) => {
    const output = options.generator.output?.value;
    if (!output) {
      throw new Error('[prisma-audit-generator] The generator block has no "output".');
    }

    await mkdir(output, { recursive: true });
    const files = renderAuditSchemaFiles(toAuditSchema(options.dmmf.datamodel));
    await Promise.all(Object.entries(files).map(([fileName, content]) => writeFile(join(output, fileName), content)));
  },
});
