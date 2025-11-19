import { useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { apiClient } from '../../lib/api-client';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '../ui/dialog';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Textarea } from '../ui/textarea';
import { AttachmentSelector } from './AttachmentSelector';

type PostFormProps = {
  onSuccess: () => void;
};

export const PostForm = ({ onSuccess }: PostFormProps) => {
  const [isOpen, setIsOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [tags, setTags] = useState('');
  const [published, setPublished] = useState(true);
  const [selectedAttachments, setSelectedAttachments] = useState<string[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { user } = useAuth();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!title.trim()) {
      setError('Title is required');
      return;
    }

    if (!user) {
      setError('You must be logged in to post');
      return;
    }

    setIsSubmitting(true);

    try {
      const tagList = tags
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t.length > 0);

      const attachments = selectedAttachments.map((url, index) => ({
        fileUrl: url,
        fileName: `attachment-${index + 1}.jpg`,
      }));

      await apiClient.createPost({
        title: title.trim(),
        content: content.trim() || '',
        published,
        authorId: user.id,
        tags: tagList.length > 0 ? tagList : undefined,
        attachments: attachments.length > 0 ? attachments : undefined,
      });

      // Reset form
      setTitle('');
      setContent('');
      setTags('');
      setPublished(true);
      setSelectedAttachments([]);
      setIsOpen(false);
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create post');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <Button size="lg" className="absolute bottom-0 right-0 rounded-full shadow-lg">
          + New Post
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Create New Post</DialogTitle>
          <DialogDescription>Share your thoughts with the community</DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="title">Title *</Label>
            <Input
              id="title"
              placeholder="What's on your mind?"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={isSubmitting}
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="content">Content</Label>
            <Textarea
              id="content"
              placeholder="Share more details..."
              value={content}
              onChange={(e) => setContent(e.target.value)}
              disabled={isSubmitting}
              className="min-h-[120px]"
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="tags">Tags</Label>
            <Input
              id="tags"
              placeholder="javascript, react, typescript (comma-separated)"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              disabled={isSubmitting}
            />
          </div>

          <AttachmentSelector selectedUrls={selectedAttachments} onSelectionChange={setSelectedAttachments} />

          <div className="flex items-center gap-2">
            <Checkbox
              id="published"
              checked={published}
              onCheckedChange={(checked) => setPublished(checked === true)}
              disabled={isSubmitting}
            />
            <Label htmlFor="published" className="font-normal">
              Publish immediately
            </Label>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="flex gap-2">
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Creating...' : 'Create Post'}
            </Button>
            <Button type="button" variant="outline" onClick={() => setIsOpen(false)} disabled={isSubmitting}>
              Cancel
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
};
