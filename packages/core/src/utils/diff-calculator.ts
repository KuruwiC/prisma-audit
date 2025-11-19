/**
 * Diff calculation utilities for audit logging
 *
 * @module diff-calculator
 *
 * @remarks
 * Compares before/after states of records and identifies field-level changes.
 * Supports ignoring specific fields (e.g., timestamps, version fields).
 *
 * @example
 * ```typescript
 * const calculateDiff = createDiffCalculator(new Set(['updatedAt']));
 *
 * const changes = calculateDiff(
 *   { id: '1', name: 'Alice', age: 30, updatedAt: '2024-01-01' },
 *   { id: '1', name: 'Alice', age: 31, updatedAt: '2024-01-02' }
 * );
 * // => { age: { old: 30, new: 31 } }
 * ```
 */

/**
 * Represents a change in a single field
 */
export interface FieldChange {
  old: unknown;
  new: unknown;
}

/**
 * Result of diff calculation
 *
 * Returns field-level changes or null if no changes detected
 */
export type DiffResult = Record<string, FieldChange> | null;

/**
 * Function type for calculating diffs between two states
 *
 * @param before - State before the change (null/undefined indicates no previous state)
 * @param after - State after the change (null/undefined indicates no new state)
 * @returns Object containing field-level changes, or null if no changes
 */
export type DiffCalculator = (
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
) => DiffResult;

/**
 * Compares two values for equality using JSON serialization
 *
 * @remarks
 * Handles nested objects and arrays but has limitations with special types (Date, Map, Set, etc.)
 */
const areValuesEqual = (oldValue: unknown, newValue: unknown): boolean => {
  return JSON.stringify(oldValue) === JSON.stringify(newValue);
};

/**
 * Type guard for valid record state (not null or undefined)
 */
const isValidState = (state: Record<string, unknown> | null | undefined): state is Record<string, unknown> => {
  return state !== null && state !== undefined;
};

/**
 * Creates a diff calculator with ignored fields
 *
 * @param ignoredFields - Field names to exclude from diff calculation
 * @returns Diff calculator function
 *
 * @example
 * ```typescript
 * const calculateDiff = createDiffCalculator(new Set(['updatedAt', 'version']));
 * const changes = calculateDiff(
 *   { id: '1', name: 'Alice', updatedAt: '2024-01-01', version: 1 },
 *   { id: '1', name: 'Bob', updatedAt: '2024-01-02', version: 2 }
 * );
 * // => { name: { old: 'Alice', new: 'Bob' } }
 * ```
 */
export const createDiffCalculator = (ignoredFields: Set<string>): DiffCalculator => {
  return (
    before: Record<string, unknown> | null | undefined,
    after: Record<string, unknown> | null | undefined,
  ): DiffResult => {
    if (!isValidState(before) || !isValidState(after)) {
      return null;
    }

    const changes: Record<string, FieldChange> = {};
    const allFieldNames = new Set([...Object.keys(before), ...Object.keys(after)]);

    for (const fieldName of allFieldNames) {
      if (ignoredFields.has(fieldName)) {
        continue;
      }

      const oldValue = before[fieldName];
      const newValue = after[fieldName];

      if (!areValuesEqual(oldValue, newValue)) {
        changes[fieldName] = { old: oldValue, new: newValue };
      }
    }

    return Object.keys(changes).length > 0 ? changes : null;
  };
};
