/**
 * Splits the demo's audit config source into its parts, so the Config page can show the file as it
 * is and link a model straight to the lines that decide where its writes are recorded.
 *
 * It reads the file's layout: an entity is `  Name: defineEntity(` up to the next
 * `  }),`, and a client-wide setting inside `defineConfig` is either one `  key: value,` line or
 * `  key: {` up to the next `  },`. Each takes the comment lines written right above it. A test runs
 * this over the real file, so a layout change fails there instead of breaking the links.
 */

export type AggregateDeclaration = { aggregate: string; line: number };

export type ConfigSection = {
  id: string;
  kind: 'model' | 'setting';
  /** Zero-based, inclusive */
  start: number;
  end: number;
  aggregates: AggregateDeclaration[];
  /** Whether a model's writes are also recorded under the model itself (`selfAggregate: false` turns it off) */
  selfAggregate: boolean;
};

const MODEL_START = /^ {2}(\w+): defineEntity\b/;
const MODEL_END = /^ {2}\}\),\s*$/;
const SETTING_START = /^ {2}(\w+): \{\s*$/;
const SETTING_LINE = /^ {2}(\w+): .+,\s*$/;
const SETTING_END = /^ {2}\},?\s*$/;
const CONFIG_START = /^export default defineConfig\b/;
const COMMENT = /^ {2}\/\//;
const AGGREGATE_DECLARATION = /\bto\('(\w+)'/g;
const SELF_OFF = /^\s*selfAggregate: false,/;

const withLeadingComments = (lines: string[], start: number) => {
  let first = start;
  while (first > 0 && COMMENT.test(lines[first - 1] ?? '')) first -= 1;
  return first;
};

const endOf = (lines: string[], from: number, end: RegExp) => {
  for (let index = from; index < lines.length; index += 1) {
    if (end.test(lines[index] ?? '')) return index;
  }
  return lines.length - 1;
};

const aggregatesIn = (lines: string[], start: number, end: number): AggregateDeclaration[] =>
  lines
    .slice(start, end + 1)
    .flatMap((text, offset) =>
      [...text.matchAll(AGGREGATE_DECLARATION)].flatMap((found) =>
        found[1] ? [{ aggregate: found[1], line: start + offset }] : [],
      ),
    );

type Entry = { id: string; kind: ConfigSection['kind']; end: RegExp | null };

/** The entry a line opens, if any: a model before `defineConfig`, a setting inside it. `end: null` is a one-line entry */
const entryAt = (line: string, inConfig: boolean): Entry | null => {
  if (!inConfig) {
    const model = MODEL_START.exec(line)?.[1];
    return model ? { id: model, kind: 'model', end: MODEL_END } : null;
  }
  const block = SETTING_START.exec(line)?.[1];
  if (block) return { id: block, kind: 'setting', end: SETTING_END };
  const single = SETTING_LINE.exec(line)?.[1];
  return single ? { id: single, kind: 'setting', end: null } : null;
};

export const configSections = (source: string): ConfigSection[] => {
  const lines = source.split('\n');
  const configStart = lines.findIndex((line) => CONFIG_START.test(line));
  const sections: ConfigSection[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const entry = entryAt(lines[index] ?? '', configStart !== -1 && index > configStart);
    if (!entry) continue;
    const end = entry.end ? endOf(lines, index + 1, entry.end) : index;
    sections.push({
      id: entry.id,
      kind: entry.kind,
      start: withLeadingComments(lines, index),
      end,
      aggregates: entry.kind === 'model' ? aggregatesIn(lines, index, end) : [],
      selfAggregate: entry.kind === 'model' && !lines.slice(index, end + 1).some((line) => SELF_OFF.test(line)),
    });
    index = end;
  }
  return sections;
};
