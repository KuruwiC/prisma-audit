# @kuruwic/prisma-audit-core

Framework-agnostic core for audit logging with Prisma.

## Installation

```bash
pnpm add @kuruwic/prisma-audit-core
```

## Usage

```typescript
import { createAsyncLocalStorageProvider } from '@kuruwic/prisma-audit-core';

const provider = createAsyncLocalStorageProvider();

await provider.runAsync(
  {
    actor: { category: 'user', type: 'User', id: 'user-123' },
  },
  async () => {
    // Context available in nested calls
    const ctx = provider.getContext();
  }
);
```

See the [main README](../../README.md) for full documentation.

## License

MIT
