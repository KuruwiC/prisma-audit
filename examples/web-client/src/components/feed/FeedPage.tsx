import { useQuery } from '@tanstack/react-query';
import { apiClient } from '../../lib/api-client';
import { PostCard } from './PostCard';
import { PostForm } from './PostForm';

type FeedPageProps = {
  onPostClick?: (postId: string) => void;
  onUserClick?: (userId: string) => void;
};

export const FeedPage = ({ onPostClick, onUserClick }: FeedPageProps) => {
  const {
    data: posts,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ['feed'],
    queryFn: () => apiClient.getFeed(),
    refetchInterval: 30000, // 30秒ごとに自動更新
  });

  if (isLoading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <p className="text-muted-foreground">Loading feed...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <p className="text-destructive">
          Failed to load feed: {error instanceof Error ? error.message : 'Unknown error'}
        </p>
      </div>
    );
  }

  return (
    <div className="relative mx-auto max-w-2xl pb-20">
      <h1 className="mb-6 text-3xl font-bold">Feed</h1>

      <div className="flex flex-col gap-4">
        {posts && posts.length > 0 ? (
          posts.map((post) => (
            <PostCard
              key={post.id}
              post={post}
              onCommentAdded={refetch}
              onPostClick={onPostClick}
              onUserClick={onUserClick}
            />
          ))
        ) : (
          <div className="rounded border p-8 text-center">
            <p className="text-muted-foreground">No posts yet. Be the first to share something!</p>
          </div>
        )}
      </div>

      <PostForm onSuccess={refetch} />
    </div>
  );
};
