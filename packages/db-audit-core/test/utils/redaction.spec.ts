import { describe, expect, it } from 'vitest';
import { createRedactor, type RedactedFieldInfo, redactSensitiveData } from '../../src/utils/redaction.js';

const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
};

describe('createRedactor', () => {
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

  it('should leave its input unchanged, returning new objects and arrays', () => {
    const input = deepFreeze({
      id: 1,
      password: 'secret',
      profile: { token: 'abc', tags: ['a', { apiKey: 'key' }] },
      changes: { secret: { old: 'x', new: 'y' }, name: { old: 'A', new: 'B' } },
    });
    const snapshot = structuredClone(input);

    const redacted = createRedactor()(input) as typeof input;

    expect(input).toStrictEqual(snapshot);
    expect(redacted).not.toBe(input);
    expect(redacted.profile).not.toBe(input.profile);
    expect(redacted.profile.tags).not.toBe(input.profile.tags);
    expect(redacted.changes.name).not.toBe(input.changes.name);
  });
});

describe('non-plain objects', () => {
  class Account {
    password = 'secret123';
  }

  it('should return a Date and a class instance as they are, without traversing them', () => {
    const redactor = createRedactor();
    const createdAt = new Date('2025-01-10');
    const account = new Account();

    const redacted = redactor({ createdAt, account, password: 'secret123' }) as Record<string, unknown>;

    expect(redacted.createdAt).toBe(createdAt);
    expect(redacted.account).toBe(account);
    expect(account.password).toBe('secret123');
    expect(redacted.password).toEqual({ redacted: true, hadValue: true });
  });

  it('should traverse an object without a prototype like a plain object', () => {
    const redactor = createRedactor();
    const row = Object.assign(Object.create(null) as Record<string, unknown>, { id: 1, password: 'secret123' });

    expect(redactor({ row })).toStrictEqual({ row: { id: 1, password: { redacted: true, hadValue: true } } });
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

  it('should leave the input unchanged', () => {
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

  it('redacts a sensitive field four levels deep', () => {
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

  it('should redact a sensitive field that is undefined to null', () => {
    const redactor = createRedactor();

    const redacted = redactor({ id: 'user-123', password: undefined }) as Record<string, unknown>;

    expect(redacted).toStrictEqual({ id: 'user-123', password: null });
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

describe('redactSensitiveData with values JSON cannot hold', () => {
  it('should keep Date values and redact beside them', () => {
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

  it('should keep BigInt values and redact beside them', () => {
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

describe('BigInt safety in redaction', () => {
  describe('redactChangeObject (via createRedactor)', () => {
    it('should correctly detect different BigInt values in redacted change', () => {
      const redactor = createRedactor();
      const data = {
        password: { old: 100n, new: 200n },
      };
      const result = redactor(data) as Record<string, unknown>;
      const password = result.password as Record<string, unknown>;
      expect(password.old).toEqual({ redacted: true, hadValue: true });
      expect(password.new).toEqual({ redacted: true, hadValue: true, isDifferent: true });
    });

    it('should correctly detect equal BigInt values in redacted change', () => {
      const redactor = createRedactor();
      const data = {
        password: { old: 100n, new: 100n },
      };
      const result = redactor(data) as Record<string, unknown>;
      const password = result.password as Record<string, unknown>;
      expect(password.old).toEqual({ redacted: true, hadValue: true });
      expect(password.new).toEqual({ redacted: true, hadValue: true, isDifferent: false });
    });
  });
});
