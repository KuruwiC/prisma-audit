import { type FormEvent, useId, useState } from 'react';
import { ActivityFeed, QuerySnippet } from '@/components/trace/activity-feed';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { useActor } from '@/lib/actor';
import { api, type Person } from '@/lib/api';
import { useWrite } from '@/lib/write';

const inputClass = 'h-9 w-full rounded-control border border-line bg-surface px-3 text-sm';

const ProfileForm = ({ person }: { person: Person }) => {
  const [name, setName] = useState(person.name ?? '');
  const [bio, setBio] = useState(person.bio ?? '');
  const [password, setPassword] = useState('');
  const [saved, setSaved] = useState(false);
  const ids = { name: useId(), bio: useId(), password: useId() };
  const save = useWrite(api.updatePerson);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSaved(false);
    save.mutate(
      { name, bio, ...(password ? { password } : {}) },
      {
        onSuccess: () => {
          setPassword('');
          setSaved(true);
        },
      },
    );
  };

  return (
    <form onSubmit={submit} className="space-y-3 px-5 py-5">
      <h2 className="font-semibold">Your profile</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={ids.name} className="mb-1 block text-sm text-ink-muted">
            Name
          </label>
          <input id={ids.name} value={name} onChange={(event) => setName(event.target.value)} className={inputClass} />
        </div>
        <div>
          <label htmlFor={ids.password} className="mb-1 block text-sm text-ink-muted">
            New password
          </label>
          <input
            id={ids.password}
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className={inputClass}
          />
        </div>
      </div>
      <div>
        <label htmlFor={ids.bio} className="mb-1 block text-sm text-ink-muted">
          Bio
        </label>
        <textarea
          id={ids.bio}
          value={bio}
          onChange={(event) => setBio(event.target.value)}
          rows={2}
          className={`${inputClass} h-auto py-2`}
        />
      </div>
      <div className="flex items-center gap-3">
        <p className="text-xs text-ink-muted">
          A password change is recorded, but its value is redacted in the audit row.
        </p>
        <Button type="submit" variant="primary" className="ml-auto shrink-0" disabled={save.isPending}>
          Save profile
        </Button>
      </div>
      {saved ? <output className="text-sm text-ink">Profile saved.</output> : null}
      {save.error ? <p className="text-sm text-danger">{save.error.message}</p> : null}
    </form>
  );
};

export const PersonPage = ({ id }: { id: string }) => {
  const { people, me } = useActor();
  const person = people.find((candidate) => candidate.id === id);

  if (!person) {
    return (
      <p className="rounded-sheet bg-surface px-5 py-10 text-center text-ink-muted">
        This person is not in the demo data.
      </p>
    );
  }

  return (
    <div className="divide-y divide-line overflow-hidden rounded-sheet bg-surface">
      <header className="flex items-center gap-4 px-5 py-6">
        <Avatar name={person.name} size="lg" />
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold">{person.name}</h1>
          <p className="text-ink-muted">{person.bio ?? 'No bio yet.'}</p>
        </div>
      </header>
      {me?.id === person.id ? <ProfileForm key={person.id} person={person} /> : null}
      <section className="space-y-4 px-5 py-5" aria-labelledby="activity-heading">
        <div>
          <h2 id="activity-heading" className="font-semibold">
            Activity
          </h2>
          <p className="mt-1 text-sm text-ink-muted">
            Read from the audit log of the User aggregate: posts, comments, likes and profile changes all land here
            because each is mapped to its author.
          </p>
        </div>
        <QuerySnippet perspective={{ kind: 'aggregate', type: 'User', id: person.id }} tone="light" />
        <ActivityFeed perspective={{ kind: 'aggregate', type: 'User', id: person.id }} tone="light" />
      </section>
    </div>
  );
};
