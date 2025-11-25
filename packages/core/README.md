# @kuruwic/prisma-audit-core

Framework-agnostic core for audit logging with Prisma.

## Installation

> **Note**: This package is not yet published to npm. Install the main package from GitHub.

```bash
# Install from GitHub
pnpm add github:kuruwic/prisma-audit#main
```

This package is included as a dependency of `@kuruwic/prisma-audit`.

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
