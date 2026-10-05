/**
 * What a Prisma client supports, from its version (`Prisma.prismaVersion.client`)
 *
 * @module utils/prisma-version
 */

interface MajorMinor {
  readonly major: number;
  readonly minor: number;
}

const majorMinorOf = (version: string | undefined): MajorMinor | undefined => {
  const match = /^(\d+)\.(\d+)/.exec(version ?? '');
  return match ? { major: Number(match[1]), minor: Number(match[2]) } : undefined;
};

const isAtLeast = (version: MajorMinor, minimum: MajorMinor): boolean =>
  version.major > minimum.major || (version.major === minimum.major && version.minor >= minimum.minor);

/**
 * Whether a client of `version` accepts a query `omit`: generally available from Prisma 6.2.0;
 * earlier clients reject it unless the `omitApi` preview is on, which the client does not expose.
 * False when the version is unknown.
 */
export const supportsQueryOmit = (version: string | undefined): boolean => {
  const parsed = majorMinorOf(version);
  return parsed !== undefined && isAtLeast(parsed, { major: 6, minor: 2 });
};
