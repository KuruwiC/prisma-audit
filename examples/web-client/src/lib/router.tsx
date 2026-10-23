import { type AnchorHTMLAttributes, type MouseEvent, useSyncExternalStore } from 'react';

export type Route =
  | { name: 'feed' }
  | { name: 'activity' }
  | { name: 'audit' }
  | { name: 'person'; id: string }
  | { name: 'config'; section: string | null };

const subscribe = (onChange: () => void) => {
  window.addEventListener('popstate', onChange);
  window.addEventListener('hashchange', onChange);
  return () => {
    window.removeEventListener('popstate', onChange);
    window.removeEventListener('hashchange', onChange);
  };
};

const parse = (location: string): Route => {
  const [pathname = '/', hash = ''] = location.split('#');
  if (pathname === '/config') return { name: 'config', section: hash ? decodeURIComponent(hash) : null };
  if (pathname === '/activity') return { name: 'activity' };
  if (pathname === '/audit') return { name: 'audit' };
  const person = /^\/people\/([^/]+)$/.exec(pathname);
  if (person?.[1]) return { name: 'person', id: decodeURIComponent(person[1]) };
  return { name: 'feed' };
};

const hrefOf = (route: Route): string => {
  switch (route.name) {
    case 'feed':
      return '/';
    case 'activity':
      return '/activity';
    case 'audit':
      return '/audit';
    case 'person':
      return `/people/${encodeURIComponent(route.id)}`;
    case 'config':
      return route.section ? `/config#${encodeURIComponent(route.section)}` : '/config';
    default: {
      const unreachable: never = route;
      return unreachable;
    }
  }
};

const navigate = (route: Route) => {
  window.history.pushState(null, '', hrefOf(route));
  window.dispatchEvent(new PopStateEvent('popstate'));
  window.scrollTo({ top: 0 });
};

export const useRoute = (): Route =>
  parse(useSyncExternalStore(subscribe, () => `${window.location.pathname}${window.location.hash}`));

type LinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & { to: Route };

export const Link = ({ to, onClick, ...props }: LinkProps) => (
  <a
    {...props}
    href={hrefOf(to)}
    onClick={(event: MouseEvent<HTMLAnchorElement>) => {
      onClick?.(event);
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
      event.preventDefault();
      navigate(to);
    }}
  />
);
