import { afterEach, describe, expect, it, vi } from 'vitest';
import { policy } from '../src/policy/index.js';

describe('policy', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([true, false])('is atomic exactly when awaited is %s', (awaited) => {
    expect(policy('User', { awaited, samplingRate: 1 })).toEqual({ sampled: true, atomic: awaited });
  });

  it.each([true, false])('is atomic exactly when the awaited function returns %s', (awaited) => {
    expect(policy('User', { awaited: () => awaited, samplingRate: 1 })).toEqual({ sampled: true, atomic: awaited });
  });

  it('calls the awaited function once with the model name', () => {
    const awaited = vi.fn(() => true);

    policy('Payment', { awaited, samplingRate: 1 });

    expect(awaited).toHaveBeenCalledTimes(1);
    expect(awaited).toHaveBeenCalledWith('Payment');
  });

  it('decides per model with the awaited function', () => {
    const config = { awaited: (modelName: string) => modelName === 'Payment', samplingRate: 1 };

    expect(policy('Payment', config)).toEqual({ sampled: true, atomic: true });
    expect(policy('Comment', config)).toEqual({ sampled: true, atomic: false });
  });

  describe('samplingRate', () => {
    it('samples out every operation at a rate of 0 and never calls the awaited function for it', () => {
      const awaited = vi.fn(() => true);

      expect(policy('User', { awaited, samplingRate: 0 })).toEqual({ sampled: false });
      expect(awaited).not.toHaveBeenCalled();
    });

    it('samples in an operation whose random draw is below the rate, and out one at the rate', () => {
      const random = vi.spyOn(Math, 'random');

      random.mockReturnValueOnce(0.49);
      expect(policy('User', { awaited: true, samplingRate: 0.5 })).toEqual({ sampled: true, atomic: true });
      random.mockReturnValueOnce(0.5);
      expect(policy('User', { awaited: true, samplingRate: 0.5 })).toEqual({ sampled: false });
    });

    it('takes the rate from the samplingRate function, called once with the model name', () => {
      const samplingRate = vi.fn((modelName: string) => (modelName === 'Payment' ? 1 : 0));

      expect(policy('Payment', { awaited: false, samplingRate })).toEqual({ sampled: true, atomic: false });
      expect(policy('Comment', { awaited: false, samplingRate })).toEqual({ sampled: false });
      expect(samplingRate).toHaveBeenCalledTimes(2);
      expect(samplingRate).toHaveBeenNthCalledWith(1, 'Payment');
      expect(samplingRate).toHaveBeenNthCalledWith(2, 'Comment');
    });
  });
});
