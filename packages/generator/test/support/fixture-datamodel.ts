import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { DMMF } from '@prisma/generator-helper';
import prismaInternals from '@prisma/internals';

const FIXTURE_PATH = fileURLToPath(new URL('../fixtures/schema.prisma', import.meta.url));

/** The datamodel Prisma hands a generator for `test/fixtures/schema.prisma`, computed in-process. */
export const loadFixtureDatamodel = async (): Promise<DMMF.Datamodel> => {
  const dmmf = await prismaInternals.getDMMF({ datamodel: readFileSync(FIXTURE_PATH, 'utf8') });
  return dmmf.datamodel;
};
