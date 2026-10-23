import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useActor } from '@/lib/actor';
import { api } from '@/lib/api';
import { HistoryDrawer, type HistoryTarget } from '../history/history-drawer';
import { Composer } from './composer';
import { PostItem } from './post-item';

export const FeedPage = () => {
  const { me } = useActor();
  const { data: posts, error } = useQuery({
    queryKey: ['feed', me?.id ?? null],
    queryFn: () => api.feed(me?.id ?? null),
  });
  const [history, setHistory] = useState<HistoryTarget | null>(null);

  return (
    <>
      <div className="divide-y divide-line overflow-hidden rounded-sheet bg-surface">
        <Composer />
        {error ? (
          <p className="px-5 py-6 text-sm text-danger">
            The feed did not load: {error.message}. Is the API running on port 3000?
          </p>
        ) : null}
        {posts?.length === 0 ? (
          <p className="px-5 py-10 text-center text-ink-muted">No posts yet. Write the first one above.</p>
        ) : null}
        {posts?.map((post) => (
          <PostItem key={post.id} post={post} onHistory={setHistory} />
        ))}
      </div>
      <HistoryDrawer target={history} onClose={() => setHistory(null)} />
    </>
  );
};
