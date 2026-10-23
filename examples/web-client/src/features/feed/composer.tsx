import { type FormEvent, useId, useState } from 'react';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { useActor } from '@/lib/actor';
import { ApiError, api } from '@/lib/api';
import { useRollbacks } from '@/lib/rollbacks';
import { useWrite } from '@/lib/write';

const parseTags = (text: string) =>
  text
    .split(/[\s,]+/)
    .map((tag) => tag.replace(/^#/, ''))
    .filter(Boolean);

export const Composer = () => {
  const { me } = useActor();
  const { record } = useRollbacks();
  const [content, setContent] = useState('');
  const [tags, setTags] = useState('');
  const [fail, setFail] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'rolled-back' | 'error'; text: string } | null>(null);
  const ids = { content: useId(), tags: useId(), fail: useId() };

  const create = useWrite(api.createPost);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setNotice(null);
    create.mutate(
      { content, tags: parseTags(tags), failInTransaction: fail },
      {
        onSuccess: () => {
          setContent('');
          setTags('');
          setNotice({ tone: 'ok', text: 'Posted.' });
        },
        onError: (error) => {
          if (error instanceof ApiError && error.rolledBack) {
            record({
              requestId: error.requestId ?? crypto.randomUUID(),
              method: 'POST',
              path: '/api/posts',
              at: new Date().toISOString(),
              actor: me?.name ?? 'Someone',
            });
            setNotice({ tone: 'rolled-back', text: 'Rolled back. Nothing was written, including the audit rows.' });
            return;
          }
          setNotice({ tone: 'error', text: error.message });
        },
      },
    );
  };

  return (
    <form onSubmit={submit} className="flex gap-3 px-5 py-4">
      <Avatar name={me?.name ?? null} />
      <div className="min-w-0 flex-1">
        <label htmlFor={ids.content} className="sr-only">
          Post
        </label>
        <textarea
          id={ids.content}
          value={content}
          onChange={(event) => setContent(event.target.value)}
          placeholder={me ? `What changed today, ${me.name?.split(' ')[0] ?? 'friend'}?` : 'Loading people…'}
          rows={2}
          className="block w-full resize-none bg-transparent text-lg leading-snug placeholder:text-ink-muted/70"
        />
        <div className="mt-2 flex items-center gap-2">
          <label htmlFor={ids.tags} className="sr-only">
            Tags
          </label>
          <input
            id={ids.tags}
            value={tags}
            onChange={(event) => setTags(event.target.value)}
            placeholder="#tags, separated by spaces"
            className="h-8 min-w-0 flex-1 rounded-control bg-paper px-3 text-sm placeholder:text-ink-muted/70"
          />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
          <label
            htmlFor={ids.fail}
            className="flex cursor-pointer items-center gap-2 text-sm text-ink-muted select-none"
          >
            <input
              id={ids.fail}
              type="checkbox"
              checked={fail}
              onChange={(event) => setFail(event.target.checked)}
              className="size-4 accent-danger"
            />
            Fail inside the transaction
          </label>
          <Button
            type="submit"
            variant="primary"
            className="ml-auto"
            disabled={!me || !content.trim() || create.isPending}
          >
            {create.isPending ? 'Posting…' : 'Post'}
          </Button>
        </div>
        {fail ? (
          <p className="mt-2 text-xs text-ink-muted">
            The post and its tags are written, then the handler throws before the transaction commits.
          </p>
        ) : null}
        {notice ? (
          <output
            className={
              notice.tone === 'ok'
                ? 'mt-2 text-sm text-ink'
                : notice.tone === 'rolled-back'
                  ? 'mt-2 text-sm text-ink'
                  : 'mt-2 text-sm text-danger'
            }
          >
            {notice.text}
          </output>
        ) : null}
      </div>
    </form>
  );
};
