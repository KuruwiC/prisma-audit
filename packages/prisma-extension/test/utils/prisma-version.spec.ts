import { describe, expect, it } from 'vitest';
import { supportsQueryOmit } from '../../src/utils/prisma-version.js';

describe('supportsQueryOmit', () => {
  it.each([
    ['6.2.0', true],
    ['6.19.0', true],
    ['7.0.0', true],
    ['6.1.9', false],
    ['5.22.0', false],
    ['', false],
    [undefined, false],
  ])('%s: %s', (version, expected) => {
    expect(supportsQueryOmit(version)).toBe(expected);
  });
});
