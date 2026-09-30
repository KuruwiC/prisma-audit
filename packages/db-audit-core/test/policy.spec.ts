import { afterEach, describe, expect, it, vi } from 'vitest';
import { policy } from '../src/policy/index.js';

describe('policy', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([true, false])('is atomic exactly when awaitWrite is %s and no awaitWriteIf is configured', (awaitWrite) => {
    expect(policy('User', [], { awaitWrite, sampling: 1 })).toEqual({ sampled: true, atomic: awaitWrite });
  });

  it.each([
    [true, false],
    [false, true],
  ])('lets awaitWriteIf override awaitWrite %s with %s', (awaitWrite, override) => {
    expect(policy('User', [], { awaitWrite, awaitWriteIf: () => override, sampling: 1 })).toEqual({
      sampled: true,
      atomic: override,
    });
  });

  it('passes the model name and its tags to awaitWriteIf', () => {
    const awaitWriteIf = vi.fn(() => true);

    policy('Payment', ['critical', 'financial'], { awaitWrite: false, awaitWriteIf, sampling: 1 });

    expect(awaitWriteIf).toHaveBeenCalledTimes(1);
    expect(awaitWriteIf).toHaveBeenCalledWith('Payment', ['critical', 'financial']);
  });

  it('decides per model from the tags', () => {
    const config = {
      awaitWrite: false,
      awaitWriteIf: (_modelName: string, tags: readonly string[]) => tags.includes('critical'),
      sampling: 1,
    };

    expect(policy('Payment', ['critical'], config)).toEqual({ sampled: true, atomic: true });
    expect(policy('Comment', [], config)).toEqual({ sampled: true, atomic: false });
  });

  describe('sampling', () => {
    it('samples out every operation at a rate of 0 and never consults awaitWriteIf for it', () => {
      const awaitWriteIf = vi.fn(() => true);

      expect(policy('User', [], { awaitWrite: true, awaitWriteIf, sampling: 0 })).toEqual({ sampled: false });
      expect(awaitWriteIf).not.toHaveBeenCalled();
    });

    it('samples in an operation whose random draw is below the rate, and out one at the rate', () => {
      const random = vi.spyOn(Math, 'random');

      random.mockReturnValueOnce(0.49);
      expect(policy('User', [], { awaitWrite: true, sampling: 0.5 })).toEqual({ sampled: true, atomic: true });
      random.mockReturnValueOnce(0.5);
      expect(policy('User', [], { awaitWrite: true, sampling: 0.5 })).toEqual({ sampled: false });
    });

    it('lets samplingIf replace sampling, called once with the model name and its tags', () => {
      const samplingIf = vi.fn(() => 1);

      expect(policy('Payment', ['financial'], { awaitWrite: false, sampling: 0, samplingIf })).toEqual({
        sampled: true,
        atomic: false,
      });
      expect(samplingIf).toHaveBeenCalledTimes(1);
      expect(samplingIf).toHaveBeenCalledWith('Payment', ['financial']);
    });
  });
});
