---
"@kuruwic/prisma-audit": minor
---

Tell the rows a nested to-many create inserts by the keys the extension generates for them, instead of by the rows that appeared.

Below a row that exists before the operation, a nested `create`, `createMany`, or the `create` of an `upsert` or `connectOrCreate` whose target does not exist, inserts rows next to the rows the relation already holds. They were told apart by the primary keys the relation held before the write, read ahead of it, so a child another transaction inserted below the same parent in between was recorded as created by the nested create.

- Behavior change: when such a row's data leaves out every primary-key field and each has a `cuid()`, `cuid(2)`, `uuid()`, `uuid(4)` or `uuid(7)` default, the extension now fills them in before the write with the same generator, as it does for a top-level `createMany`. Query extensions applied after the audit extension, and the value Prisma returns, see that key.
- The created rows are the rows with the keys the extension generated; a child another writer inserts is not recorded, and no row of the relation is read before the write.
- A row whose key the extension does not generate (one the caller gives, which the database may store in another form or a later write of the operation may change; an `autoincrement()` key; a key field the relation fills from the parent row), the rows of a relation another write of the operation gives a key field to, and the rows of a `createMany` with `skipDuplicates`, are still told apart by the primary keys read ahead of the write, with the race above.
