/** The thrown value as an `Error`: itself when it is one, else an `Error` whose message is its string form. */
export const toError = (caught: unknown): Error => (caught instanceof Error ? caught : new Error(String(caught)));
