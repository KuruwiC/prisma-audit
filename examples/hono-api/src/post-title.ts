const TITLE_LENGTH = 80;

/** A post's title is its first line, shortened: the label its audit rows carry */
export const titleOf = (content: string) => {
  const firstLine = content.split('\n')[0] ?? content;
  return firstLine.length > TITLE_LENGTH ? `${firstLine.slice(0, TITLE_LENGTH - 1)}…` : firstLine;
};
