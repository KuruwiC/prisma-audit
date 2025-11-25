import { describe, expect, it } from 'vitest';
import {
  createRedactor,
  getDefaultSensitiveFields,
  isSensitiveField,
  type RedactedFieldInfo,
  redactSensitiveData,
} from '../../src/index.js';

describe('getDefaultSensitiveFields', () => {
  it('should return default sensitive field patterns', () => {
    const fields = getDefaultSensitiveFields();

    expect(fields).toContain('password');
    expect(fields).toContain('token');
    expect(fields).toContain('apiKey');
    expect(fields).toContain('secret');
    expect(fields.length).toBeGreaterThan(0);
  });
});

describe('isSensitiveField', () => {
  it('should identify default sensitive fields (exact match)', () => {
    expect(isSensitiveField('password')).toBe(true);
    expect(isSensitiveField('passwordHash')).toBe(true);
    expect(isSensitiveField('token')).toBe(true);
    expect(isSensitiveField('apiKey')).toBe(true);
    expect(isSensitiveField('secret')).toBe(true);
  });

  it('should be case-sensitive', () => {
    expect(isSensitiveField('PASSWORD')).toBe(false);
    expect(isSensitiveField('Password')).toBe(false);
    expect(isSensitiveField('ApiKey')).toBe(false);
  });

  it('should identify non-sensitive fields', () => {
    expect(isSensitiveField('id')).toBe(false);
    expect(isSensitiveField('name')).toBe(false);
    expect(isSensitiveField('email')).toBe(false);
    expect(isSensitiveField('createdAt')).toBe(false);
  });

  it('should support custom sensitive fields', () => {
    expect(isSensitiveField('customField', ['customField'])).toBe(true);
    expect(isSensitiveField('anotherField', ['customField'])).toBe(false);
  });

  it('should merge custom fields with defaults', () => {
    const customFields = ['customSecret'];
    expect(isSensitiveField('password', customFields)).toBe(true); // default
    expect(isSensitiveField('customSecret', customFields)).toBe(true); // custom
  });
});

describe('createRedactor', () => {
  it('should create redactor with default config', () => {
    const redactor = createRedactor();

    expect(redactor).toBeDefined();
    expect(typeof redactor).toBe('function');
  });

  it('should redact sensitive fields', () => {
    const redactor = createRedactor();
    const data = {
      id: 'user-123',
      name: 'John Doe',
      password: 'secret123',
      email: 'john@example.com',
    };

    const redacted = redactor(data) as Record<string, unknown>;

    expect(redacted).toEqual({
      id: 'user-123',
      name: 'John Doe',
      password: {
        redacted: true,
        hadValue: true,
      } satisfies RedactedFieldInfo,
      email: 'john@example.com',
    });
  });

  it('should support custom sensitive fields', () => {
    const redactor = createRedactor({ fields: ['customSecret'] });
    const data = {
      name: 'John',
      customSecret: 'my-secret',
      password: 'pass123', // default field
    };

    const redacted = redactor(data) as Record<string, unknown>;

    expect(redacted).toEqual({
      name: 'John',
      customSecret: {
        redacted: true,
        hadValue: true,
      } satisfies RedactedFieldInfo,
      password: {
        redacted: true,
        hadValue: true,
      } satisfies RedactedFieldInfo,
    });
  });

  it('should handle nested objects', () => {
    const redactor = createRedactor();
    const data = {
      user: {
        id: 'user-123',
        password: 'secret123',
        profile: {
          name: 'John',
          apiKey: 'key-456',
        },
      },
    };

    const redacted = redactor(data) as Record<string, unknown>;

    expect(redacted).toEqual({
      user: {
        id: 'user-123',
        password: {
          redacted: true,
          hadValue: true,
        } satisfies RedactedFieldInfo,
        profile: {
          name: 'John',
          apiKey: {
            redacted: true,
            hadValue: true,
          } satisfies RedactedFieldInfo,
        },
      },
    });
  });

  it('should handle arrays', () => {
    const redactor = createRedactor();
    const data = {
      users: [
        { id: 'user-1', password: 'pass1' },
        { id: 'user-2', password: 'pass2' },
      ],
    };

    const redacted = redactor(data) as Record<string, unknown>;

    expect(redacted).toEqual({
      users: [
        {
          id: 'user-1',
          password: {
            redacted: true,
            hadValue: true,
          } satisfies RedactedFieldInfo,
        },
        {
          id: 'user-2',
          password: {
            redacted: true,
            hadValue: true,
          } satisfies RedactedFieldInfo,
        },
      ],
    });
  });

  it('should preserve non-object types', () => {
    const redactor = createRedactor();

    expect(redactor('string')).toBe('string');
    expect(redactor(123)).toBe(123);
    expect(redactor(true)).toBe(true);
    expect(redactor(null)).toBe(null);
    expect(redactor(undefined)).toBe(undefined);
  });

  it('should handle Date objects', () => {
    const redactor = createRedactor();
    const date = new Date('2024-01-01');
    const data = { createdAt: date };

    const redacted = redactor(data);

    expect(redacted).toBeDefined();
  });

  it('should NOT redact case variations (case-sensitive)', () => {
    const redactor = createRedactor();
    const data = {
      password: 'secret1', // exact match - should redact
      Password: 'secret2', // different case - should NOT redact
      TOKEN: 'secret3', // different case - should NOT redact
    };

    const redacted = redactor(data) as Record<string, unknown>;

    expect(redacted).toEqual({
      password: {
        redacted: true,
        hadValue: true,
      } satisfies RedactedFieldInfo,
      Password: 'secret2',
      TOKEN: 'secret3',
    });
  });
});

describe('redactSensitiveData', () => {
  it('should redact with default config', () => {
    const data = {
      id: 'user-123',
      name: 'John Doe',
      password: 'secret123',
    };

    const redacted = redactSensitiveData(data) as Record<string, unknown>;

    expect(redacted).toEqual({
      id: 'user-123',
      name: 'John Doe',
      password: {
        redacted: true,
        hadValue: true,
      } satisfies RedactedFieldInfo,
    });
  });

  it('should accept custom config', () => {
    const data = { password: 'secret', customField: 'sensitive' };
    const config = {
      fields: ['customField'],
    };

    const redacted = redactSensitiveData(data, config) as Record<string, unknown>;

    expect(redacted).toEqual({
      password: {
        redacted: true,
        hadValue: true,
      } satisfies RedactedFieldInfo,
      customField: {
        redacted: true,
        hadValue: true,
      } satisfies RedactedFieldInfo,
    });
  });

  it('should handle primitive values', () => {
    expect(redactSensitiveData('string')).toBe('string');
    expect(redactSensitiveData(123)).toBe(123);
    expect(redactSensitiveData(null)).toBe(null);
  });

  it('should deep clone data', () => {
    const original = { name: 'John', password: 'secret' };
    const redacted = redactSensitiveData(original) as Record<string, unknown>;

    // Original should not be mutated
    expect(original.password).toBe('secret');
    expect(redacted.password).toEqual({
      redacted: true,
      hadValue: true,
    } satisfies RedactedFieldInfo);
  });
});

describe('edge cases', () => {
  it('should handle empty objects', () => {
    const redactor = createRedactor();
    const data = {};

    const redacted = redactor(data);

    expect(redacted).toEqual({});
  });

  it('should handle deeply nested structures', () => {
    const redactor = createRedactor();
    const data = {
      level1: {
        level2: {
          level3: {
            level4: {
              password: 'deep-secret',
            },
          },
        },
      },
    };

    const redacted = redactor(data);

    expect(redacted).toBeDefined();
    const level4 = ((redacted as Record<string, unknown>).level1 as Record<string, unknown>).level2 as Record<
      string,
      unknown
    >;
    expect(((level4.level3 as Record<string, unknown>).level4 as Record<string, unknown>).password).toEqual({
      redacted: true,
      hadValue: true,
    } satisfies RedactedFieldInfo);
  });

  it('should handle mixed arrays and objects', () => {
    const redactor = createRedactor();
    const data = {
      items: [{ id: 1, token: 'token1' }, { id: 2, nested: { secret: 'secret2' } }, 'plain string', 42],
    };

    const redacted = redactor(data) as Record<string, unknown>;

    expect(redacted).toEqual({
      items: [
        {
          id: 1,
          token: {
            redacted: true,
            hadValue: true,
          } satisfies RedactedFieldInfo,
        },
        {
          id: 2,
          nested: {
            secret: {
              redacted: true,
              hadValue: true,
            } satisfies RedactedFieldInfo,
          },
        },
        'plain string',
        42,
      ],
    });
  });

  it('should handle multiple sensitive fields in same object', () => {
    const redactor = createRedactor();
    const data = {
      username: 'john',
      password: 'pass123',
      token: 'token456',
      apiKey: 'key789',
      secret: 'secret000',
    };

    const redacted = redactor(data) as Record<string, unknown>;

    expect(redacted).toEqual({
      username: 'john',
      password: {
        redacted: true,
        hadValue: true,
      } satisfies RedactedFieldInfo,
      token: {
        redacted: true,
        hadValue: true,
      } satisfies RedactedFieldInfo,
      apiKey: {
        redacted: true,
        hadValue: true,
      } satisfies RedactedFieldInfo,
      secret: {
        redacted: true,
        hadValue: true,
      } satisfies RedactedFieldInfo,
    });
  });
});

describe('redaction metadata', () => {
  it('should create redaction metadata for single value', () => {
    const redactor = createRedactor();
    const data = {
      id: 'user-123',
      name: 'John Doe',
      password: 'secret123',
    };

    const redacted = redactor(data) as Record<string, unknown>;

    expect(redacted.id).toBe('user-123');
    expect(redacted.name).toBe('John Doe');
    expect(redacted.password).toEqual({
      redacted: true,
      hadValue: true,
    } satisfies RedactedFieldInfo);
  });

  it('should handle null values in redaction', () => {
    const redactor = createRedactor();
    const data = {
      id: 'user-123',
      password: null,
    };

    const redacted = redactor(data) as Record<string, unknown>;

    expect(redacted.id).toBe('user-123');
    expect(redacted.password).toBe(null);
  });

  it('should detect changes for change objects', () => {
    const redactor = createRedactor();
    const data = {
      password: {
        old: 'oldPassword123',
        new: 'newPassword456',
      },
    };

    const redacted = redactor(data) as Record<string, unknown>;
    const passwordChange = redacted.password as { old: RedactedFieldInfo; new: RedactedFieldInfo };

    expect(passwordChange.old).toEqual({
      redacted: true,
      hadValue: true,
    });
    expect(passwordChange.new).toEqual({
      redacted: true,
      hadValue: true,
      isDifferent: true,
    });
  });

  it('should detect when value is unchanged', () => {
    const redactor = createRedactor();
    const data = {
      password: {
        old: 'samePassword123',
        new: 'samePassword123',
      },
    };

    const redacted = redactor(data) as Record<string, unknown>;
    const passwordChange = redacted.password as { old: RedactedFieldInfo; new: RedactedFieldInfo };

    expect(passwordChange.new.isDifferent).toBe(false);
  });

  it('should handle null to value change', () => {
    const redactor = createRedactor();
    const data = {
      password: {
        old: null,
        new: 'newPassword123',
      },
    };

    const redacted = redactor(data) as Record<string, unknown>;
    const passwordChange = redacted.password as { old: null; new: RedactedFieldInfo };

    expect(passwordChange.old).toBe(null);
    expect(passwordChange.new).toEqual({
      redacted: true,
      hadValue: true,
      isDifferent: true,
    });
  });

  it('should handle value to null change', () => {
    const redactor = createRedactor();
    const data = {
      password: {
        old: 'oldPassword123',
        new: null,
      },
    };

    const redacted = redactor(data) as Record<string, unknown>;
    const passwordChange = redacted.password as { old: RedactedFieldInfo; new: null };

    expect(passwordChange.old).toEqual({
      redacted: true,
      hadValue: true,
    });
    expect(passwordChange.new).toBe(null);
  });

  it('should handle nested objects', () => {
    const redactor = createRedactor();
    const data = {
      user: {
        id: 'user-123',
        password: 'secret123',
        profile: {
          apiKey: 'key-456',
        },
      },
    };

    const redacted = redactor(data) as Record<string, unknown>;
    const user = redacted.user as Record<string, unknown>;
    const profile = user.profile as Record<string, unknown>;

    expect(user.id).toBe('user-123');
    expect(user.password).toEqual({
      redacted: true,
      hadValue: true,
    });
    expect(profile.apiKey).toEqual({
      redacted: true,
      hadValue: true,
    });
  });

  it('should handle complex change objects with multiple sensitive fields', () => {
    const redactor = createRedactor();
    const data = {
      password: {
        old: 'oldPassword123',
        new: 'newPassword456',
      },
      apiKey: {
        old: 'oldKey123',
        new: 'oldKey123', // unchanged
      },
      token: {
        old: null,
        new: 'newToken789',
      },
    };

    const redacted = redactor(data) as Record<string, unknown>;

    // Password changed
    const passwordChange = redacted.password as { old: RedactedFieldInfo; new: RedactedFieldInfo };
    expect(passwordChange.new.isDifferent).toBe(true);

    // ApiKey unchanged
    const apiKeyChange = redacted.apiKey as { old: RedactedFieldInfo; new: RedactedFieldInfo };
    expect(apiKeyChange.new.isDifferent).toBe(false);

    // Token added (null → value)
    const tokenChange = redacted.token as { old: null; new: RedactedFieldInfo };
    expect(tokenChange.old).toBe(null);
    expect(tokenChange.new.isDifferent).toBe(true);
  });
});

describe('structuredClone support in redactSensitiveData', () => {
  it('should handle Date objects correctly with structuredClone', () => {
    const now = new Date('2025-01-10T12:00:00Z');
    const data = {
      id: 1,
      createdAt: now,
      password: 'secret123',
    };

    const redacted = redactSensitiveData(data) as Record<string, unknown>;

    expect(redacted.id).toBe(1);
    expect(redacted.createdAt).toEqual(now);

    expect(redacted.password).toEqual({ redacted: true, hadValue: true });
  });

  it('should handle BigInt correctly with structuredClone', () => {
    const data = {
      id: 123n,
      largeNumber: 9007199254740991n,
      password: 'secret',
    };

    const redacted = redactSensitiveData(data) as Record<string, unknown>;

    expect(redacted.id).toBe(123n);
    expect(redacted.largeNumber).toBe(9007199254740991n);

    expect(redacted.password).toEqual({ redacted: true, hadValue: true });
  });

  it('should handle circular references with structuredClone', () => {
    const data: Record<string, unknown> = {
      id: 1,
      password: 'secret',
    };
    data.self = data;

    expect(() => {
      redactSensitiveData(data);
    }).toThrow(RangeError);
  });

  it('should fallback to JSON when structuredClone fails with functions', () => {
    const data = {
      id: 1,
      callback: () => console.log('test'),
      password: 'secret',
    };

    const redacted = redactSensitiveData(data) as Record<string, unknown>;

    expect(redacted.callback).toBeUndefined();

    expect(redacted.password).toEqual({ redacted: true, hadValue: true });
  });

  it('should fallback to JSON when structuredClone fails with symbols', () => {
    const sym = Symbol('test');
    const data = {
      id: 1,
      [sym]: 'symbol-value',
      password: 'secret',
    };

    const redacted = redactSensitiveData(data) as Record<string, unknown>;

    expect((redacted as Record<string | symbol, unknown>)[sym]).toBeUndefined();

    expect(redacted.password).toEqual({ redacted: true, hadValue: true });
  });

  it('should handle nested objects with Date and BigInt', () => {
    const data = {
      user: {
        id: 1n,
        createdAt: new Date('2025-01-10'),
        password: 'secret123',
        profile: {
          lastLogin: new Date('2025-01-11'),
          token: 'token123',
        },
      },
    };

    const redacted = redactSensitiveData(data) as Record<string, unknown>;
    const user = redacted.user as Record<string, unknown>;
    const profile = user.profile as Record<string, unknown>;

    expect(user.id).toBe(1n);
    expect(user.createdAt).toEqual(new Date('2025-01-10'));
    expect(profile.lastLogin).toEqual(new Date('2025-01-11'));

    expect(user.password).toEqual({ redacted: true, hadValue: true });
    expect(profile.token).toEqual({ redacted: true, hadValue: true });
  });

  it('should handle arrays with Date objects', () => {
    const data = {
      events: [
        { createdAt: new Date('2025-01-10'), password: 'secret1' },
        { createdAt: new Date('2025-01-11'), apiKey: 'key123' },
      ],
    };

    const redacted = redactSensitiveData(data) as Record<string, unknown>;
    const events = redacted.events as Array<Record<string, unknown>>;
    const [event0, event1] = events;

    expect(event0?.createdAt).toEqual(new Date('2025-01-10'));
    expect(event1?.createdAt).toEqual(new Date('2025-01-11'));

    expect(event0?.password).toEqual({ redacted: true, hadValue: true });
    expect(event1?.apiKey).toEqual({ redacted: true, hadValue: true });
  });
});
