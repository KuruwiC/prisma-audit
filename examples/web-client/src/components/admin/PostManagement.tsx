import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../../lib/api-client';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';

export const PostManagement = () => {
  const queryClient = useQueryClient();

  const { data: posts, isLoading } = useQuery({
    queryKey: ['admin-posts'],
    queryFn: () => apiClient.getPosts(),
  });

  const updatePostMutation = useMutation({
    mutationFn: ({ id, published }: { id: string; published: boolean }) => apiClient.updatePost(id, { published }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-posts'] });
      queryClient.invalidateQueries({ queryKey: ['feed'] });
    },
  });

  const deletePostMutation = useMutation({
    mutationFn: (postId: string) => apiClient.deletePost(postId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-posts'] });
      queryClient.invalidateQueries({ queryKey: ['feed'] });
    },
  });

  const handleTogglePublished = (postId: string, currentPublished: boolean) => {
    updatePostMutation.mutate({ id: postId, published: !currentPublished });
  };

  if (isLoading) {
    return <p className="text-muted-foreground">Loading posts...</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-2xl font-bold">Post Management</h2>

      <div className="rounded border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Title</TableHead>
              <TableHead>Author</TableHead>
              <TableHead>Published</TableHead>
              <TableHead>Tags</TableHead>
              <TableHead>Created At</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {posts && posts.length > 0 ? (
              posts.map((post) => (
                <TableRow key={post.id}>
                  <TableCell className="font-medium">{post.title}</TableCell>
                  <TableCell>{post.author.name || post.author.email}</TableCell>
                  <TableCell>
                    <Checkbox
                      checked={post.published}
                      onCheckedChange={() => handleTogglePublished(post.id, post.published)}
                      disabled={updatePostMutation.isPending}
                    />
                  </TableCell>
                  <TableCell>
                    {post.postTags && post.postTags.length > 0
                      ? post.postTags.map((pt) => pt.tag.name).join(', ')
                      : '-'}
                  </TableCell>
                  <TableCell>{new Date(post.createdAt).toLocaleDateString()}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => deletePostMutation.mutate(post.id)}
                      disabled={deletePostMutation.isPending}
                    >
                      Delete
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={6} className="text-center">
                  No posts found
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
};
