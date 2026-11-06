---
"@kuruwic/prisma-audit": minor
---

Record no create for a child another writer inserts below a parent row while a nested to-many create whose keys the extension does not generate runs.

- The rows new below a parent row are counted against the rows the operation's nested creates insert under it. When more rows are new, only the rows whose key shows they are the operation's (a key the extension generated, or a whole key a `create`, or a `createMany` without `skipDuplicates`, gives) are recorded. The other inserts are reported as `row-identification` under the nested write that inserts them; under `atomic` the operation fails with `AuditIncompleteError` and rolls back.
- When several elements of an operation name the same parent row, the creates nested under each of them are counted, and an inserted row whose key shows which create inserted it is recorded for that create.
