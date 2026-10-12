/** A promise the test resolves itself, so the test decides when the code awaiting it resumes */
export const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};
