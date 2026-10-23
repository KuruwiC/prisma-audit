import { ScrollText, X } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { TraceRail } from './components/trace/trace-rail';
import { Avatar } from './components/ui/avatar';
import { ActivityPage } from './features/activity/activity-page';
import { AuditPage } from './features/audit/audit-page';
import { ConfigPage } from './features/config/config-page';
import { FeedPage } from './features/feed/feed-page';
import { PersonPage } from './features/people/person-page';
import { useActor } from './lib/actor';
import { cx } from './lib/cx';
import { Link, type Route, useRoute } from './lib/router';

const Mark = () => (
  <svg viewBox="0 0 32 32" className="size-7" aria-hidden>
    <title>Commons</title>
    <rect width="32" height="32" rx="8" className="fill-ink" />
    <path
      d="M10 9v14M10 16h6M16 16l6-6M16 16l6 6"
      className="stroke-agg-post-glow"
      strokeWidth="2.5"
      strokeLinecap="round"
      fill="none"
    />
  </svg>
);

const NavLink = ({ to, current, children }: { to: Route; current: Route; children: string }) => (
  <Link
    to={to}
    aria-current={to.name === current.name ? 'page' : undefined}
    className="rounded-control px-3 py-1.5 text-sm font-medium text-ink-muted hover:text-ink aria-[current=page]:bg-ink/6 aria-[current=page]:text-ink"
  >
    {children}
  </Link>
);

const ActingAs = () => {
  const { people, me, actAs } = useActor();
  return (
    <fieldset className="flex items-center gap-1">
      <legend className="sr-only">Acting as</legend>
      <span className="mr-1 hidden text-sm text-ink-muted md:inline">Acting as</span>
      {people.map((person) => {
        const active = person.id === me?.id;
        return (
          <button
            key={person.id}
            type="button"
            aria-pressed={active}
            onClick={() => actAs(person.id)}
            title={person.name ?? person.email}
            aria-label={person.name ?? person.email}
            className={cx(
              'flex shrink-0 items-center gap-2 rounded-full p-0.5 transition-colors',
              active ? 'bg-ink text-surface sm:pr-3' : 'opacity-60 hover:opacity-100',
            )}
          >
            <Avatar name={person.name} size="sm" />
            {active ? (
              <span className="hidden max-w-36 truncate text-sm font-medium sm:inline">
                {person.name?.split(' ')[0]}
              </span>
            ) : null}
          </button>
        );
      })}
    </fieldset>
  );
};

export const App = () => {
  const route = useRoute();
  const [trailOpen, setTrailOpen] = useState(false);
  const [unseen, setUnseen] = useState(0);
  const closeButton = useRef<HTMLButtonElement>(null);
  const openButton = useRef<HTMLButtonElement>(null);

  // The sheet is hidden while closed, so focus moves only once the state change has rendered
  const openTrail = () => {
    flushSync(() => {
      setTrailOpen(true);
      setUnseen(0);
    });
    closeButton.current?.focus();
  };
  const closeTrail = () => {
    flushSync(() => setTrailOpen(false));
    openButton.current?.focus();
  };
  const withRail = route.name !== 'audit' && route.name !== 'config';

  const countUnseen = useCallback(
    (requestIds: string[]) => {
      if (!trailOpen) setUnseen((count) => count + requestIds.length);
    },
    [trailOpen],
  );

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-20 border-b border-line bg-paper/90 backdrop-blur">
        <div className="flex h-14 items-center gap-2 px-3 sm:gap-3 sm:px-4 lg:px-6">
          <Link to={{ name: 'feed' }} className="flex shrink-0 items-center gap-2.5">
            <Mark />
            <span className="hidden text-lg font-semibold tracking-tight sm:inline">Commons</span>
            <span className="hidden text-sm text-ink-muted md:inline">prisma-audit demo</span>
          </Link>
          <nav className="flex min-w-0 gap-0.5 overflow-x-auto whitespace-nowrap sm:ml-2 sm:gap-1" aria-label="Main">
            <NavLink to={{ name: 'feed' }} current={route}>
              Feed
            </NavLink>
            <NavLink to={{ name: 'activity' }} current={route}>
              Activity
            </NavLink>
            <NavLink to={{ name: 'audit' }} current={route}>
              Audit log
            </NavLink>
            <NavLink to={{ name: 'config', section: null }} current={route}>
              Config
            </NavLink>
          </nav>
          <div className="ml-auto shrink-0">
            <ActingAs />
          </div>
        </div>
      </header>

      <div className={cx(withRail && 'lg:grid lg:grid-cols-[minmax(0,1fr)_420px]')}>
        <main className="px-3 py-5 sm:px-6 lg:py-8">
          <div className={cx('mx-auto', withRail ? 'max-w-[620px]' : 'max-w-[1120px]')}>
            {route.name === 'feed' ? <FeedPage /> : null}
            {route.name === 'person' ? <PersonPage id={route.id} /> : null}
            {route.name === 'activity' ? <ActivityPage /> : null}
            {route.name === 'audit' ? <AuditPage /> : null}
            {route.name === 'config' ? <ConfigPage section={route.section} /> : null}
          </div>
        </main>

        {withRail ? (
          <>
            <aside
              onKeyDown={(event) => {
                if (event.key === 'Escape' && trailOpen) closeTrail();
              }}
              className={cx(
                'fixed inset-x-0 bottom-0 z-30 h-[80dvh] overflow-hidden rounded-t-sheet shadow-2xl motion-safe:duration-300',
                'lg:visible lg:sticky lg:top-14 lg:z-auto lg:h-[calc(100dvh-3.5rem)] lg:translate-y-0 lg:rounded-none lg:shadow-none',
                // Hidden, not only moved off-screen: a closed sheet leaves the tab order and the accessibility tree.
                // It turns visible at once on open, so focus can move in, and hides after the slide on close
                trailOpen
                  ? 'visible translate-y-0 motion-safe:transition-transform'
                  : 'invisible translate-y-full motion-safe:transition-[transform,visibility]',
              )}
            >
              <button
                ref={closeButton}
                type="button"
                onClick={closeTrail}
                aria-label="Close the audit trail"
                className="absolute top-4 right-4 z-10 rounded-control p-1.5 text-trace-muted hover:text-trace-ink lg:hidden"
              >
                <X size={18} />
              </button>
              <TraceRail onNewRequests={countUnseen} />
            </aside>
            <button
              ref={openButton}
              type="button"
              aria-expanded={trailOpen}
              onClick={openTrail}
              className={cx(
                'fixed right-4 bottom-4 z-20 flex items-center gap-2 rounded-full bg-trace px-4 py-2.5 text-sm font-medium text-trace-ink shadow-lg lg:hidden',
                trailOpen && 'hidden',
              )}
            >
              <ScrollText size={16} />
              Audit trail
              {unseen > 0 ? (
                <span className="label rounded-full bg-trace-ink px-1.5 text-xs text-trace">{unseen} new</span>
              ) : null}
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
};
