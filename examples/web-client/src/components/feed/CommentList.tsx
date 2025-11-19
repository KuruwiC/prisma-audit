import { useAuth } from '../../contexts/AuthContext';
import { apiClient } from '../../lib/api-client';
import type { Comment } from '../../types/api';
import { Button } from '../ui/button';

type CommentListProps = {
  postId: string;
  comments: Comment[];
  onCommentDeleted: () => void;
};

export const CommentList = ({ comments, onCommentDeleted }: CommentListProps) => {
  const { user } = useAuth();

  const handleDelete = async (commentId: string) => {
    try {
      await apiClient.deleteComment(commentId);
      onCommentDeleted();
    } catch (error) {
      console.error('Failed to delete comment:', error);
    }
  };

  const getAuthorAvatar = (comment: Comment) => {
    return comment.author.profile?.avatar?.avatarImage?.imageUrl || 'https://i.pravatar.cc/150?img=1';
  };

  const getAuthorName = (comment: Comment) => {
    return comment.author.name || comment.author.email;
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  if (comments.length === 0) {
    return (
      <div className="w-full rounded border p-4 text-center text-sm text-muted-foreground">
        No comments yet. Be the first to comment!
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col gap-3">
      {comments.map((comment) => (
        <div key={comment.id} className="flex gap-3 rounded border p-3">
          <img src={getAuthorAvatar(comment)} alt={getAuthorName(comment)} className="h-8 w-8 rounded-full" />
          <div className="flex flex-1 flex-col gap-1">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <p className="text-xs font-semibold">{getAuthorName(comment)}</p>
                <p className="text-xs text-muted-foreground">{formatDate(comment.createdAt)}</p>
              </div>
              {user?.id === comment.authorId && (
                <Button variant="ghost" size="sm" onClick={() => handleDelete(comment.id)} className="h-6 px-2 text-xs">
                  Delete
                </Button>
              )}
            </div>
            <p className="text-sm">{comment.content}</p>
            {comment.commentAttachments && comment.commentAttachments.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {comment.commentAttachments.map((ca) => (
                  <img
                    key={ca.id}
                    src={ca.attachment.fileUrl}
                    alt={ca.attachment.fileName}
                    className="h-32 w-32 rounded object-cover"
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
};
