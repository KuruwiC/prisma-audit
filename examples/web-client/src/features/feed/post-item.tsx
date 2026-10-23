import { Heart, History, MessageCircle, Pencil, Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { useActor } from '@/lib/actor';
import { api, type FeedComment, type FeedPost } from '@/lib/api';
import { cx } from '@/lib/cx';
import { Link } from '@/lib/router';
import { fullTime, timeAgo } from '@/lib/time';
import { useWrite } from '@/lib/write';
import type { HistoryTarget } from '../history/history-drawer';

const Byline = ({ author, at }: { author: FeedPost['author']; at: string }) => (
  <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
    <Link to={{ name: 'person', id: author.id }} className="max-w-full min-w-0 truncate font-semibold hover:underline">
      {author.name}
    </Link>
    <time dateTime={at} title={fullTime(at)} className="label text-ink-muted">
      {timeAgo(at)}
    </time>
  </p>
);

const CommentRow = ({ comment, onHistory }: { comment: FeedComment; onHistory: (target: HistoryTarget) => void }) => {
  const { me } = useActor();
  const remove = useWrite((actorId, id: string) => api.deleteComment(actorId, id));
  return (
    <li className="group/comment flex gap-2.5 py-2">
      <Avatar name={comment.author.name} size="sm" />
      <div className="min-w-0 flex-1">
        <Byline author={comment.author} at={comment.createdAt} />
        <p className="text-sm">{comment.content}</p>
      </div>
      <div className="flex shrink-0 items-start opacity-100 sm:opacity-0 sm:group-hover/comment:opacity-100 sm:group-focus-within/comment:opacity-100">
        <Button
          size="sm"
          aria-label="Comment history"
          onClick={() => onHistory({ aggregateType: 'Comment', aggregateId: comment.id, label: comment.content })}
        >
          <History size={14} />
        </Button>
        {me?.id === comment.author.id ? (
          <Button size="sm" variant="danger" aria-label="Delete comment" onClick={() => remove.mutate(comment.id)}>
            <Trash2 size={14} />
          </Button>
        ) : null}
      </div>
    </li>
  );
};

type PostItemProps = { post: FeedPost; onHistory: (target: HistoryTarget) => void };

export const PostItem = ({ post, onHistory }: PostItemProps) => {
  const { me } = useActor();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(post.content);
  const [commentsOpen, setCommentsOpen] = useState(post.comments.length > 0);
  const [comment, setComment] = useState('');

  const like = useWrite((actorId, liked: boolean) => api.setLike(actorId, post.id, liked));
  const edit = useWrite((actorId, content: string) => api.editPost(actorId, post.id, content));
  const remove = useWrite((actorId, _: undefined) => api.deletePost(actorId, post.id));
  const addComment = useWrite((actorId, content: string) => api.comment(actorId, post.id, content));

  const mine = me?.id === post.author.id;
  const edited = post.updatedAt !== post.createdAt;

  const saveEdit = (event: FormEvent) => {
    event.preventDefault();
    edit.mutate(draft, { onSuccess: () => setEditing(false) });
  };

  const submitComment = (event: FormEvent) => {
    event.preventDefault();
    addComment.mutate(comment, { onSuccess: () => setComment('') });
  };

  return (
    <article className="flex gap-3 px-5 py-4" aria-label={`Post by ${post.author.name}`}>
      <Avatar name={post.author.name} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <Byline author={post.author} at={post.createdAt} />
          {edited ? <span className="label text-xs text-ink-muted">edited</span> : null}
        </div>

        {editing ? (
          <form onSubmit={saveEdit} className="mt-1.5">
            <label className="sr-only" htmlFor={`edit-${post.id}`}>
              Edit post
            </label>
            <textarea
              id={`edit-${post.id}`}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              rows={3}
              className="block w-full rounded-control border border-line bg-surface px-3 py-2"
            />
            <div className="mt-2 flex justify-end gap-2">
              <Button onClick={() => setEditing(false)}>Cancel</Button>
              <Button type="submit" variant="primary" disabled={!draft.trim() || edit.isPending}>
                Save edit
              </Button>
            </div>
          </form>
        ) : (
          <p className="mt-0.5 text-base whitespace-pre-line">{post.content}</p>
        )}

        {post.tags.length > 0 ? (
          <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-sm text-agg-tag" aria-label="Tags">
            {post.tags.map((tag) => (
              <li key={tag} className="label">
                #{tag}
              </li>
            ))}
          </ul>
        ) : null}

        <div className="mt-2 -ml-2 flex flex-wrap items-center gap-0.5">
          <Button
            size="sm"
            aria-pressed={post.likedByMe}
            onClick={() => like.mutate(!post.likedByMe)}
            disabled={!me || like.isPending}
            className={cx(post.likedByMe && 'text-ink')}
          >
            <Heart size={15} fill={post.likedByMe ? 'currentColor' : 'none'} />
            {post.likeCount}
          </Button>
          <Button size="sm" aria-expanded={commentsOpen} onClick={() => setCommentsOpen((open) => !open)}>
            <MessageCircle size={15} />
            {post.comments.length}
          </Button>
          <Button
            size="sm"
            onClick={() => onHistory({ aggregateType: 'Post', aggregateId: post.id, label: post.content })}
          >
            <History size={15} />
            History
          </Button>
          {mine && !editing ? (
            <span className="ml-auto flex">
              <Button
                size="sm"
                onClick={() => {
                  setDraft(post.content);
                  setEditing(true);
                }}
              >
                <Pencil size={14} />
                Edit
              </Button>
              <Button size="sm" variant="danger" onClick={() => remove.mutate(undefined)} disabled={remove.isPending}>
                <Trash2 size={14} />
                Delete
              </Button>
            </span>
          ) : null}
        </div>

        {commentsOpen ? (
          <div className="mt-1 border-l-2 border-line pl-3">
            {post.comments.length > 0 ? (
              <ul>
                {post.comments.map((item) => (
                  <CommentRow key={item.id} comment={item} onHistory={onHistory} />
                ))}
              </ul>
            ) : null}
            <form onSubmit={submitComment} className="flex items-center gap-2 py-2">
              <label className="sr-only" htmlFor={`comment-${post.id}`}>
                Comment
              </label>
              <input
                id={`comment-${post.id}`}
                value={comment}
                onChange={(event) => setComment(event.target.value)}
                placeholder="Write a comment"
                className="h-8 min-w-0 flex-1 rounded-control bg-paper px-3 text-sm placeholder:text-ink-muted/70"
              />
              <Button
                type="submit"
                size="sm"
                variant="primary"
                disabled={!me || !comment.trim() || addComment.isPending}
              >
                Comment
              </Button>
            </form>
          </div>
        ) : null}
      </div>
    </article>
  );
};
