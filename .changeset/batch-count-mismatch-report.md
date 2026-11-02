---
"@kuruwic/prisma-audit": minor
---

Report an `updateMany` or `deleteMany` whose count shows that another writer changed its rows between the audit's read and the write.

The rows these operations audit are the rows a `findMany` reads ahead of the write. Each mismatch is reported to `errorObserver` as `row-identification` with `params: { unidentified }`, and the records are unchanged:

- an `updateMany` whose count is above the rows it read: a row another writer made match the `where` was updated without a record
- an `updateMany` whose count is below the read rows it finds again after the write: a row another writer moved out of the `where` was not updated, and the audit cannot tell which, so it treats every row it finds as updated
- a `deleteMany` whose count is below the rows it read: a row another writer deleted first is still recorded as deleted
- a `deleteMany` whose count is above the rows it read: a row another writer made match the `where` was deleted without a record

A swap that leaves the count unchanged is not seen. An `updateMany` or `updateManyAndReturn` whose `data` gives no field a value (every field `undefined` or `Prisma.skip`) changes no row: it runs as given, with no row read or recorded, and no count compared, since Prisma runs no `UPDATE` for it and the count it returns is not the rows written (0 on SQLite).
