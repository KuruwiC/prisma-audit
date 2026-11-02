---
"@kuruwic/prisma-audit": minor
---

Record a nested update that gives its row another key under the key the write gives it.

A nested `update`, the update branch of a nested `upsert` or a nested `updateMany` whose data wrote the row key of the rows it updated (the primary key, or the unique constraint of a model without one) found the rows again after the write by the key they had before it, so they were not found and not recorded, and nothing was reported.

- The rows are now found by the key the write gives them: the key they had with the key fields the data gives literal values (a value, or `{ set: value }`) replaced, as top-level batch updates already do. With `fetchBefore.update: false`, an update whose `where` names the whole row key is found the same way.
- Behavior change: a write whose data changes the key in a way its arguments do not tell (an operator such as `increment` on a key field, a relation whose foreign key is part of the key, or a nested `updateMany` with several elements of which one writes the key) is reported to the observer as `row-identification`, with `params: { path, unidentified }`. Its rows are still not recorded.
