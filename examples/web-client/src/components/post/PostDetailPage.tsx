import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { apiClient } from '../../lib/api-client';
import { ActivityLog } from '../activity/ActivityLog';
import { CommentForm } from '../feed/CommentForm';
import { CommentList } from '../feed/CommentList';
import { Button } from '../ui/button';
import { Card, CardContent, CardFooter, CardHeader } from '../ui/card';
import { Input } from '../ui/input';
import { PostEditForm } from './PostEditForm';

type PostDetailPageProps = {
  postId: string;
  onBack: () => void;
  onUserClick?: (userId: string) => void;
};

/**
 * Types for post data
 */
type PostData = NonNullable<Awaited<ReturnType<typeof apiClient.getFeed>>>[number];

/**
 * Helper functions for post author display
 */
const getAuthorAvatar = (post: PostData) => {
  return post.author.profile?.avatar?.avatarImage?.imageUrl || 'https://i.pravatar.cc/150?img=1';
};

const getAuthorName = (post: PostData) => {
  return post.author.name || post.author.email;
};

const formatDate = (dateString: string) => {
  return new Date(dateString).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

/**
 * Loading state component
 */
const LoadingState = () => (
  <div className="flex min-h-[50vh] items-center justify-center">
    <p className="text-muted-foreground">Loading post...</p>
  </div>
);

/**
 * Error state component
 */
const ErrorState = ({ onBack }: { onBack: () => void }) => (
  <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4">
    <p className="text-destructive">Failed to load post</p>
    <Button onClick={onBack}>Back to Feed</Button>
  </div>
);

/**
 * Post header component
 */
type PostHeaderProps = {
  post: PostData;
  onUserClick?: (userId: string) => void;
};

const PostHeader = ({ post, onUserClick }: PostHeaderProps) => (
  <CardHeader>
    <div className="flex items-center gap-3">
      <img
        src={getAuthorAvatar(post)}
        alt={getAuthorName(post)}
        className={`h-10 w-10 rounded-full object-cover ${onUserClick ? 'cursor-pointer hover:ring-2 hover:ring-primary' : ''}`}
        onClick={() => onUserClick?.(post.authorId)}
      />
      <div className="flex flex-col gap-1">
        <p
          className={`text-sm font-semibold ${onUserClick ? 'cursor-pointer hover:text-primary' : ''}`}
          onClick={() => onUserClick?.(post.authorId)}
        >
          {getAuthorName(post)}
        </p>
        <p className="text-xs text-muted-foreground">{formatDate(post.createdAt)}</p>
      </div>
    </div>
  </CardHeader>
);

/**
 * Post content component
 */
type PostContentProps = {
  post: PostData;
  isAuthor: boolean;
  tagManagement: ReturnType<typeof useTagManagement>;
};

const PostContent = ({ post, isAuthor, tagManagement }: PostContentProps) => (
  <CardContent className="flex flex-col gap-4">
    <div>
      <h3 className="mb-2 text-lg font-bold">{post.title}</h3>
      {post.content && <p className="text-sm">{post.content}</p>}
    </div>

    {post.postAttachments && post.postAttachments.length > 0 && (
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {post.postAttachments.map((pa: NonNullable<PostData['postAttachments']>[number]) => (
          <img
            key={pa.id}
            src={pa.attachment.fileUrl}
            alt={pa.attachment.fileName}
            className="h-32 w-full rounded object-cover"
          />
        ))}
      </div>
    )}

    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="flex flex-wrap gap-2">
          {post.postTags && post.postTags.length > 0 ? (
            post.postTags.map((pt: NonNullable<PostData['postTags']>[number]) => (
              <span key={pt.id} className="rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
                #{pt.tag.name}
              </span>
            ))
          ) : (
            <span className="text-xs text-muted-foreground">No tags</span>
          )}
        </div>
        {isAuthor && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => tagManagement.setShowAddTagForm(!tagManagement.showAddTagForm)}
          >
            + Add Tags
          </Button>
        )}
      </div>

      {tagManagement.showAddTagForm && (
        <form onSubmit={tagManagement.handleAddTags} className="flex gap-2">
          <Input
            placeholder="react, typescript, nodejs (comma-separated)"
            value={tagManagement.newTags}
            onChange={(e) => tagManagement.setNewTags(e.target.value)}
            disabled={tagManagement.isAddingTags}
            className="flex-1"
          />
          <Button type="submit" size="sm" disabled={tagManagement.isAddingTags}>
            {tagManagement.isAddingTags ? 'Adding...' : 'Add'}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => tagManagement.setShowAddTagForm(false)}
            disabled={tagManagement.isAddingTags}
          >
            Cancel
          </Button>
        </form>
      )}
    </div>
  </CardContent>
);

/**
 * Post comments section component
 */
type PostCommentsProps = {
  post: PostData;
  showCommentForm: boolean;
  setShowCommentForm: (show: boolean) => void;
  refetch: () => void;
};

const PostComments = ({ post, showCommentForm, setShowCommentForm, refetch }: PostCommentsProps) => (
  <CardFooter className="flex flex-col gap-3">
    <div className="flex w-full gap-2">
      <Button variant="outline" size="sm" onClick={() => setShowCommentForm(!showCommentForm)}>
        Add Comment
      </Button>
    </div>

    {showCommentForm && (
      <CommentForm
        postId={post.id}
        onSuccess={() => {
          setShowCommentForm(false);
          refetch();
        }}
        onCancel={() => setShowCommentForm(false)}
      />
    )}

    {post.comments && post.comments.length > 0 && (
      <CommentList postId={post.id} comments={post.comments} onCommentDeleted={refetch} />
    )}
  </CardFooter>
);

/**
 * Edit mode component
 */
type EditModeProps = {
  post: PostData;
  onCancel: () => void;
  onSuccess: () => void;
};

const EditMode = ({ post, onCancel, onSuccess }: EditModeProps) => (
  <div className="mx-auto max-w-2xl">
    <div className="mb-6">
      <Button variant="ghost" onClick={onCancel}>
        ← Back to Post
      </Button>
    </div>

    <h1 className="mb-6 text-3xl font-bold">Edit Post</h1>

    <PostEditForm post={post} onSuccess={onSuccess} onCancel={onCancel} />
  </div>
);

/**
 * Custom hook for tag management
 */
const useTagManagement = (postId: string, refetch: () => void) => {
  const [showAddTagForm, setShowAddTagForm] = useState(false);
  const [newTags, setNewTags] = useState('');
  const [isAddingTags, setIsAddingTags] = useState(false);

  const handleAddTags = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTags.trim()) return;

    setIsAddingTags(true);
    try {
      const tagList = newTags
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t.length > 0);

      await apiClient.addTagsToPost(postId, tagList);
      setNewTags('');
      setShowAddTagForm(false);
      refetch();
    } catch (err) {
      console.error('Failed to add tags:', err);
    } finally {
      setIsAddingTags(false);
    }
  };

  return {
    showAddTagForm,
    setShowAddTagForm,
    newTags,
    setNewTags,
    isAddingTags,
    handleAddTags,
  };
};

/**
 * Main component
 */
export const PostDetailPage = ({ postId, onBack, onUserClick }: PostDetailPageProps) => {
  const { user } = useAuth();
  const [showCommentForm, setShowCommentForm] = useState(false);
  const [isEditing, setIsEditing] = useState(false);

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

  const tagManagement = useTagManagement(postId, refetch);
  const post = posts?.find((p) => p.id === postId);

  // Early returns for loading and error states
  if (isLoading) return <LoadingState />;
  if (error || !post) return <ErrorState onBack={onBack} />;

  const isAuthor = user?.id === post.authorId;

  // Early return for edit mode
  if (isEditing && isAuthor) {
    return (
      <EditMode
        post={post}
        onCancel={() => setIsEditing(false)}
        onSuccess={() => {
          setIsEditing(false);
          refetch();
        }}
      />
    );
  }

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-6 flex items-center justify-between">
        <Button variant="ghost" onClick={onBack}>
          ← Back to Feed
        </Button>
        {isAuthor && (
          <Button variant="outline" onClick={() => setIsEditing(true)}>
            Edit Post
          </Button>
        )}
      </div>

      <h1 className="mb-6 text-3xl font-bold">Post Details</h1>

      <div className="flex flex-col gap-6">
        <Card>
          <PostHeader post={post} onUserClick={onUserClick} />
          <PostContent post={post} isAuthor={isAuthor} tagManagement={tagManagement} />
          <PostComments
            post={post}
            showCommentForm={showCommentForm}
            setShowCommentForm={setShowCommentForm}
            refetch={refetch}
          />
        </Card>

        <ActivityLog
          aggregateType="Post"
          aggregateId={post.id}
          title="Post Activity Log"
          description="Activity related to this post"
        />
      </div>
    </div>
  );
};
