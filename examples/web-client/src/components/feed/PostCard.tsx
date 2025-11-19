import { useState } from 'react';
import type { Post } from '../../types/api';
import { Button } from '../ui/button';
import { Card, CardContent, CardFooter, CardHeader } from '../ui/card';
import { CommentForm } from './CommentForm';
import { CommentList } from './CommentList';

type PostCardProps = {
  post: Post;
  onCommentAdded: () => void;
  onPostClick?: (postId: string) => void;
  onUserClick?: (userId: string) => void;
};

export const PostCard = ({ post, onCommentAdded, onPostClick, onUserClick }: PostCardProps) => {
  const [showComments, setShowComments] = useState(false);
  const [showCommentForm, setShowCommentForm] = useState(false);

  const getAuthorAvatar = () => {
    return post.author.profile?.avatar?.avatarImage?.imageUrl || 'https://i.pravatar.cc/150?img=1';
  };

  const getAuthorName = () => {
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

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <img
            src={getAuthorAvatar()}
            alt={getAuthorName()}
            className={`h-10 w-10 rounded-full object-cover ${onUserClick ? 'cursor-pointer hover:ring-2 hover:ring-primary' : ''}`}
            onClick={() => onUserClick?.(post.authorId)}
          />
          <div className="flex flex-col gap-1">
            <p
              className={`text-sm font-semibold ${onUserClick ? 'cursor-pointer hover:text-primary' : ''}`}
              onClick={() => onUserClick?.(post.authorId)}
            >
              {getAuthorName()}
            </p>
            <p className="text-xs text-muted-foreground">{formatDate(post.createdAt)}</p>
          </div>
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        <div className={onPostClick ? 'cursor-pointer' : ''} onClick={() => onPostClick?.(post.id)}>
          <h3 className="mb-2 text-lg font-bold hover:text-primary">{post.title}</h3>
          {post.content && <p className="text-sm">{post.content}</p>}
        </div>

        {post.postAttachments && post.postAttachments.length > 0 && (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {post.postAttachments.map((pa) => (
              <img
                key={pa.id}
                src={pa.attachment.fileUrl}
                alt={pa.attachment.fileName}
                className="h-32 w-full rounded object-cover"
              />
            ))}
          </div>
        )}

        {post.postTags && post.postTags.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {post.postTags.map((pt) => (
              <span key={pt.id} className="rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
                #{pt.tag.name}
              </span>
            ))}
          </div>
        )}
      </CardContent>

      <CardFooter className="flex flex-col gap-3">
        <div className="flex w-full gap-2">
          <Button variant="outline" size="sm" onClick={() => setShowComments(!showComments)}>
            {showComments ? 'Hide' : 'Show'} Comments ({post.comments?.length || 0})
          </Button>
          <Button variant="outline" size="sm" onClick={() => setShowCommentForm(!showCommentForm)}>
            Add Comment
          </Button>
        </div>

        {showCommentForm && (
          <CommentForm
            postId={post.id}
            onSuccess={() => {
              setShowCommentForm(false);
              setShowComments(true);
              onCommentAdded();
            }}
            onCancel={() => setShowCommentForm(false)}
          />
        )}

        {showComments && (
          <CommentList postId={post.id} comments={post.comments || []} onCommentDeleted={onCommentAdded} />
        )}
      </CardFooter>
    </Card>
  );
};
