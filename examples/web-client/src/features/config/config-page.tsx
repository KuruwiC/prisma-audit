import configSource from '@api/audit.config.ts?raw';
import { useEffect } from 'react';
import { AggregateChip, HueDot, hueLine } from '@/components/ui/aggregate-chip';
import { type ConfigSection, configSections } from '@/lib/config-source';
import { cx } from '@/lib/cx';
import { plural } from '@/lib/plural';
import { Link } from '@/lib/router';

const lines = configSource.split('\n').map((text, index) => ({ index, text }));
const sections = configSections(configSource);
const models = sections.filter((section) => section.kind === 'model');
const settings = sections.filter((section) => section.kind === 'setting');

const anchorOf = (id: string) => `config-${id}`;

const COMMENT_LINE = /^\s*(\/\/|\/\*\*|\*)/;

const SectionLink = ({ section, current }: { section: ConfigSection; current: boolean }) => (
  <Link
    to={{ name: 'config', section: section.id }}
    aria-current={current ? 'location' : undefined}
    className="label flex items-center gap-2 rounded-control px-2.5 py-1.5 text-sm text-ink-muted hover:bg-ink/5 hover:text-ink aria-[current=location]:bg-ink aria-[current=location]:text-surface"
  >
    {section.kind === 'model' ? <HueDot type={section.id} tone="light" /> : null}
    {section.id}
  </Link>
);

const RecordedUnder = ({ model }: { model: ConfigSection }) => {
  const aggregates = [
    ...(model.selfAggregate ? [model.id] : []),
    ...model.aggregates.map((declaration) => declaration.aggregate),
  ];
  return (
    <div className="sticky top-14 z-10 flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line bg-surface/95 px-5 py-3 text-sm backdrop-blur">
      <span className="label text-ink-muted">A {model.id} write is recorded under</span>
      {aggregates.map((aggregate) => (
        <AggregateChip
          key={aggregate}
          type={aggregate}
          label={aggregate === model.id ? 'itself' : undefined}
          tone="light"
        />
      ))}
      <span className="label text-ink-muted">{plural(aggregates.length, 'row')} per write</span>
    </div>
  );
};

export const ConfigPage = ({ section }: { section: string | null }) => {
  const selected = sections.find((candidate) => candidate.id === section) ?? null;
  // A line can declare several aggregates; it takes a hue only when it names exactly one
  const aggregatesByLine = new Map<number, string[]>();
  for (const declaration of selected?.aggregates ?? []) {
    aggregatesByLine.set(declaration.line, [...(aggregatesByLine.get(declaration.line) ?? []), declaration.aggregate]);
  }

  // Bring the selected entry into view: the target is a DOM position, not React state
  useEffect(() => {
    if (!selected) return;
    document.getElementById(anchorOf(selected.id))?.scrollIntoView({ block: 'start' });
  }, [selected]);

  return (
    // overflow-clip lets the entry list stay sticky
    <div className="overflow-clip rounded-sheet bg-surface">
      <header className="flex flex-col gap-1 border-b border-line px-5 py-5">
        <h1 className="text-xl font-semibold">Config</h1>
        <p className="max-w-[68ch] text-sm text-ink-muted">
          This file is the whole audit setup; the API's handlers only call Prisma. Each model entry decides which
          aggregates a write of that model is recorded under and what context its rows carry. The settings at the end
          apply to every write. Pick an entry, or follow a link from any recorded write, to see the lines behind it.
        </p>
        <code className="pt-1 text-ink-muted">examples/hono-api/src/audit.config.ts</code>
      </header>

      <div className="lg:grid lg:grid-cols-[200px_minmax(0,1fr)]">
        <nav aria-label="Config entries" className="border-b border-line p-3 lg:border-r lg:border-b-0">
          <div className="flex flex-wrap gap-1 lg:sticky lg:top-20 lg:flex-col">
            <p className="label w-full px-2.5 pt-1 pb-0.5 text-xs text-ink-muted">Models</p>
            {models.map((model) => (
              <SectionLink key={model.id} section={model} current={model.id === selected?.id} />
            ))}
            <p className="label w-full px-2.5 pt-3 pb-0.5 text-xs text-ink-muted">Settings</p>
            {settings.map((setting) => (
              <SectionLink key={setting.id} section={setting} current={setting.id === selected?.id} />
            ))}
          </div>
        </nav>

        <div className="min-w-0">
          {selected?.kind === 'model' ? <RecordedUnder model={selected} /> : null}
          <pre className="overflow-x-auto py-3 leading-relaxed">
            <code>
              {lines.map(({ index, text }) => {
                const owner = sections.find((candidate) => candidate.start === index);
                const inSelected = selected !== null && index >= selected.start && index <= selected.end;
                const declared = aggregatesByLine.get(index);
                return (
                  <span
                    key={index}
                    id={owner ? anchorOf(owner.id) : undefined}
                    className={cx(
                      'flex scroll-mt-36 border-l-2 pr-4 lg:scroll-mt-28',
                      inSelected ? 'bg-ink/4' : '',
                      declared ? hueLine(declared.length === 1 ? (declared[0] ?? '') : '') : 'border-transparent',
                    )}
                  >
                    <span aria-hidden className="w-12 shrink-0 pr-4 text-right text-ink-muted/60 select-none">
                      {index + 1}
                    </span>
                    <span className={cx('whitespace-pre', COMMENT_LINE.test(text) ? 'text-ink-muted' : 'text-ink')}>
                      {text || ' '}
                    </span>
                  </span>
                );
              })}
            </code>
          </pre>
        </div>
      </div>
    </div>
  );
};
