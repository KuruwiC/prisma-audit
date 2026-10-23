import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useActor } from './actor';

/**
 * A write made as the current person; it refreshes every query because the feed, the people and
 * the audit trail all change together
 */
export const useWrite = <TArgs, TResult>(write: (actorId: string, args: TArgs) => Promise<TResult>) => {
  const { me } = useActor();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: TArgs) => {
      if (!me) throw new Error('Pick a person before writing');
      return write(me.id, args);
    },
    onSettled: () => queryClient.invalidateQueries(),
  });
};
