import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { apiClient } from '../../lib/api-client';
import type { Post, UpdatePostRequest } from '../../types/api';
import { AttachmentSelector } from '../feed/AttachmentSelector';
import { Button } from '../ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Textarea } from '../ui/textarea';

type PostEditFormProps = {
  post: Post;
  onSuccess: (updatedPost: Post) => void;
  onCancel: () => void;
};

export const PostEditForm = ({ post, onSuccess, onCancel }: PostEditFormProps) => {
  const [title, setTitle] = useState(post.title);
  const [content, setContent] = useState(post.content || '');
  const [tags, setTags] = useState<string[]>(post.postTags?.map((pt) => pt.tag.name) || []);
  const [tagInput, setTagInput] = useState('');
  const [selectedImages, setSelectedImages] = useState<string[]>(
    post.postAttachments?.map((pa) => pa.attachment.fileUrl) || [],
  );

  const updatePostMutation = useMutation({
    mutationFn: async (data: UpdatePostRequest) => {
      return apiClient.updatePost(post.id, data);
    },
    onSuccess: (updatedPost) => {
      onSuccess(updatedPost);
    },
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const attachments = selectedImages.map((url, index) => ({
      fileUrl: url,
      fileName: `image-${index + 1}.jpg`,
    }));

    await updatePostMutation.mutateAsync({
      title,
      content: content || undefined,
      published: post.published,
      tags,
      attachments,
    });
  };

  const handleAddTag = () => {
    if (tagInput.trim() && !tags.includes(tagInput.trim())) {
      setTags([...tags, tagInput.trim()]);
      setTagInput('');
    }
  };

  const handleRemoveTag = (tagToRemove: string) => {
    setTags(tags.filter((tag) => tag !== tagToRemove));
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAddTag();
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Edit Post</CardTitle>
        <CardDescription>Update your post details</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="title">Title</Label>
            <Input
              id="title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Post title..."
              required
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="content">Content</Label>
            <Textarea
              id="content"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="What's on your mind?"
              className="min-h-[120px]"
            />
          </div>

          <AttachmentSelector selectedUrls={selectedImages} onSelectionChange={setSelectedImages} />

          <div className="flex flex-col gap-2">
            <Label htmlFor="tags">Tags</Label>
            <div className="flex gap-2">
              <Input
                id="tags"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Add a tag..."
              />
              <Button type="button" onClick={handleAddTag} variant="outline">
                Add
              </Button>
            </div>

            {tags.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {tags.map((tag) => (
                  <span
                    key={tag}
                    className="flex items-center gap-1 rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary"
                  >
                    #{tag}
                    <button type="button" onClick={() => handleRemoveTag(tag)} className="ml-1 hover:text-destructive">
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="flex gap-2">
            <Button type="submit" disabled={updatePostMutation.isPending}>
              {updatePostMutation.isPending ? 'Updating...' : 'Update Post'}
            </Button>
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
          </div>

          {updatePostMutation.isError && (
            <p className="text-sm text-destructive">Failed to update post. Please try again.</p>
          )}
        </form>
      </CardContent>
    </Card>
  );
};
