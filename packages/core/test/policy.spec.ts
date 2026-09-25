import { describe, expect, it, vi } from 'vitest';
import { policy } from '../src/policy/index.js';

describe('policy', () => {
  it.each([true, false])('is atomic exactly when awaitWrite is %s and no awaitWriteIf is configured', (awaitWrite) => {
    expect(policy('User', [], { awaitWrite })).toEqual({ atomic: awaitWrite });
  });

  it.each([
    [true, false],
    [false, true],
  ])('lets awaitWriteIf override awaitWrite %s with %s', (awaitWrite, override) => {
    expect(policy('User', [], { awaitWrite, awaitWriteIf: () => override })).toEqual({ atomic: override });
  });

  it('passes the model name and its tags to awaitWriteIf', () => {
    const awaitWriteIf = vi.fn(() => true);

    policy('Payment', ['critical', 'financial'], { awaitWrite: false, awaitWriteIf });

    expect(awaitWriteIf).toHaveBeenCalledTimes(1);
    expect(awaitWriteIf).toHaveBeenCalledWith('Payment', ['critical', 'financial']);
  });

  it('decides per model from the tags', () => {
    const config = {
      awaitWrite: false,
      awaitWriteIf: (_modelName: string, tags: readonly string[]) => tags.includes('critical'),
    };

    expect(policy('Payment', ['critical'], config).atomic).toBe(true);
    expect(policy('Comment', [], config).atomic).toBe(false);
  });
});
