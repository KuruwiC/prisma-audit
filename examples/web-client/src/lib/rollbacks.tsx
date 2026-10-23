import { createContext, type ReactNode, use, useCallback, useState } from 'react';

/** A request whose transaction rolled back: it left no audit rows, so the client keeps the record */
export type Rollback = { requestId: string; method: string; path: string; at: string; actor: string };

type RollbackState = { rollbacks: Rollback[]; record: (rollback: Rollback) => void };

const RollbackContext = createContext<RollbackState | null>(null);

export const RollbackProvider = ({ children }: { children: ReactNode }) => {
  const [rollbacks, setRollbacks] = useState<Rollback[]>([]);
  const record = useCallback((rollback: Rollback) => setRollbacks((current) => [rollback, ...current]), []);
  return <RollbackContext value={{ rollbacks, record }}>{children}</RollbackContext>;
};

export const useRollbacks = (): RollbackState => {
  const state = use(RollbackContext);
  if (!state) throw new Error('useRollbacks must be used inside RollbackProvider');
  return state;
};
