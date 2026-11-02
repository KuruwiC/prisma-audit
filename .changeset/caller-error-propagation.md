---
"@kuruwic/prisma-audit": patch
---

Propagate whatever the caller's own write throws exactly as thrown. A failure of the write itself, for example one a query extension applied after the audit extension raises, reaches the caller unchanged and never `errorObserver`, also when the thrown value is not an `Error` or is a frozen one. Such a value was reported as `diff-generation` and replaced by a new `Error`, and a thrown `Error` was given an extra symbol property.
