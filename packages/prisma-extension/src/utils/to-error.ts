export const toError = (caught: unknown): Error => (caught instanceof Error ? caught : new Error(String(caught)));
