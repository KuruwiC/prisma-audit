---
"@kuruwic/prisma-audit": minor
---

Record nested writes to a model identified by a unique constraint instead of a primary key.

A nested write into a model with no `@id` or `@@id`, identified by `@unique` or `@@unique` on required fields, was neither recorded nor reported: the nested pipeline told rows apart by their primary key only. It now tells them apart by the model's row key, the one batch operations already use: the primary key, else the first unique constraint whose fields are all required.

- A nested `create`, `createMany`, `update`, `upsert`, `delete`, `updateMany`, `deleteMany`, `connect`, `disconnect`, `set` or `connectOrCreate` into such a model, and the writes nested below one of its rows, record one log per row they write.
- The message of the error a nested delete whose key cannot be resolved reports now says "row key" instead of "primary key". Its `params.pkFields` keeps its name and holds the row-key fields.
