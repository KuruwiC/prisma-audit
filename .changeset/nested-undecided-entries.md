---
"@kuruwic/prisma-audit": patch
---

Tell the rows a nested create inserts below a parent apart from the rows the parent already held when the write changes the parent's key.

- A nested write below a parent row whose relation references a unique field other than its row key reads the parent's referenced values as they were before the write, so a child the parent held before a nested update changes that field is not recorded as created.
- An `updateMany` beside the write that names a parent row no longer makes the rows below that parent read as inserted: their key is followed to the key the write gives the parent.
