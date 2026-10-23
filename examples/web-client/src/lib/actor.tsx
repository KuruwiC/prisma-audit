import { useQuery } from '@tanstack/react-query';
import { createContext, type ReactNode, use, useCallback, useState } from 'react';
import { api, type Person } from './api';

const STORAGE_KEY = 'commons.actor';

type ActorState = {
  people: Person[];
  me: Person | null;
  actAs: (personId: string) => void;
};

const ActorContext = createContext<ActorState | null>(null);

const readStored = () => {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
};

export const ActorProvider = ({ children }: { children: ReactNode }) => {
  const { data: people = [] } = useQuery({ queryKey: ['people'], queryFn: api.people });
  const [chosenId, setChosenId] = useState(readStored);

  const actAs = useCallback((personId: string) => {
    setChosenId(personId);
    try {
      window.localStorage.setItem(STORAGE_KEY, personId);
    } catch {
      // Storage can be unavailable (private mode); the choice then lasts for this page load only
    }
  }, []);

  // A stored id can outlive a demo reset; fall back to the first person
  const me = people.find((person) => person.id === chosenId) ?? people[0] ?? null;

  return <ActorContext value={{ people, me, actAs }}>{children}</ActorContext>;
};

export const useActor = (): ActorState => {
  const state = use(ActorContext);
  if (!state) throw new Error('useActor must be used inside ActorProvider');
  return state;
};
