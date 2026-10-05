import { describe, expect, it } from 'vitest';
import { supportsClientOmit, supportsQueryOmit } from '../../src/utils/prisma-version.js';

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

describe('supportsClientOmit', () => {
  it.each([
    ['5.16.0', true],
    ['6.0.0', true],
    ['5.15.2', false],
    ['4.16.0', false],
    ['dev', undefined],
    [undefined, undefined],
  ])('%s: %s', (version, expected) => {
    expect(supportsClientOmit(version)).toBe(expected);
  });
});
