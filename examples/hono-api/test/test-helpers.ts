/**
 * Test Utility Functions
 */

/**
 * Polling-based helper to wait for async conditions
 */
export async function waitFor<T>(
  conditionFn: () => Promise<T>,
  options: { timeout?: number; interval?: number; checkFn?: (value: T) => boolean } = {},
): Promise<T> {
  const { timeout = 5000, interval = 100, checkFn } = options;
  const start = Date.now();

  while (Date.now() - start < timeout) {
    const value = await conditionFn();
    if (checkFn ? checkFn(value) : value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }

  throw new Error(`waitFor timed out after ${timeout}ms`);
}
