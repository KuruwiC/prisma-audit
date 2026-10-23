import { ActivityFeed, QuerySnippet } from '@/components/trace/activity-feed';
import type { Perspective } from '@/lib/activity';

const everything: Perspective = { kind: 'everything' };

export const ActivityPage = () => (
  <div className="overflow-hidden rounded-sheet bg-surface">
    <header className="flex flex-col gap-4 border-b border-line px-5 py-5">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">Activity</h1>
        <p className="max-w-[64ch] text-sm text-ink-muted">
          Everything that happened, read from the same table as the audit log. Each entry is one request: its rows are
          folded by the aggregates they were recorded under, so a post carries the tags linked with it and a deleted
          post the comments removed with it. Open the row count to see the rows behind a sentence.
        </p>
      </div>
      <QuerySnippet perspective={everything} tone="light" />
    </header>
    <div className="px-5">
      <ActivityFeed perspective={everything} tone="light" />
    </div>
  </div>
);
