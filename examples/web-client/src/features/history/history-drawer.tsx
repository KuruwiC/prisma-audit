import { ActivityFeed, QuerySnippet } from '@/components/trace/activity-feed';
import { AggregateChip } from '@/components/ui/aggregate-chip';
import { Drawer } from '@/components/ui/drawer';

export type HistoryTarget = { aggregateType: string; aggregateId: string; label: string };

const perspectiveOf = (target: HistoryTarget) =>
  ({ kind: 'aggregate', type: target.aggregateType, id: target.aggregateId }) as const;

export const HistoryDrawer = ({ target, onClose }: { target: HistoryTarget | null; onClose: () => void }) => (
  <Drawer
    open={target !== null}
    onClose={onClose}
    title={
      target ? (
        <>
          <h2 className="text-lg font-semibold">History</h2>
          <AggregateChip type={target.aggregateType} label={target.label} tone="trace" className="mt-1.5" />
        </>
      ) : null
    }
  >
    {target ? (
      <div className="space-y-5">
        <p className="text-sm text-trace-muted">
          Everything recorded under this {target.aggregateType.toLowerCase()}: its own edits and every comment, like and
          tag on it. It is one query, because each child row was also recorded under its parent. Each entry is one
          request, phrased from its rows alone.
        </p>
        <QuerySnippet perspective={perspectiveOf(target)} tone="trace" />
        <ActivityFeed perspective={perspectiveOf(target)} tone="trace" />
      </div>
    ) : null}
  </Drawer>
);
