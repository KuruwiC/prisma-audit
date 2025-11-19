import { useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { apiClient } from '../../lib/api-client';
import { Button } from '../ui/button';
import { Textarea } from '../ui/textarea';
import { AttachmentSelector } from './AttachmentSelector';

type CommentFormProps = {
  postId: string;
  onSuccess: () => void;
  onCancel: () => void;
};

export const CommentForm = ({ postId, onSuccess, onCancel }: CommentFormProps) => {
  const [content, setContent] = useState('');
  const [selectedAttachmentUrls, setSelectedAttachmentUrls] = useState<string[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { user } = useAuth();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!content.trim()) {
      setError('Comment cannot be empty');
      return;
    }

    if (!user) {
      setError('You must be logged in to comment');
      return;
    }

    setIsSubmitting(true);

    try {
      // First, create attachments for selected images
      const createdAttachmentIds: string[] = [];
      for (const url of selectedAttachmentUrls) {
        const attachment = await apiClient.createAttachment({
          fileUrl: url,
          fileName: `comment-attachment-${Date.now()}.jpg`,
          ownerId: user.id,
        });
        createdAttachmentIds.push(attachment.id);
      }

      // Then create comment with attachment IDs
      await apiClient.createComment(postId, {
        content: content.trim(),
        authorId: user.id,
        attachmentIds: createdAttachmentIds.length > 0 ? createdAttachmentIds : undefined,
      });
      setContent('');
      setSelectedAttachmentUrls([]);
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to post comment');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex w-full flex-col gap-2">
      <Textarea
        placeholder="Write a comment..."
        value={content}
        onChange={(e) => setContent(e.target.value)}
        disabled={isSubmitting}
        className="min-h-[80px]"
      />
      <AttachmentSelector selectedUrls={selectedAttachmentUrls} onSelectionChange={setSelectedAttachmentUrls} />
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={isSubmitting}>
          {isSubmitting ? 'Posting...' : 'Post Comment'}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
};
