---
"@kuruwic/prisma-audit": patch
---

Roll back an interactive transaction whose operation failed after its write reached the database through a query extension applied after the audit, even when the callback catches the error. Before, the transaction committed such a write with no audit record when an extension applied after the audit threw after its call to `query` succeeded, called `query` a second time, or settled while its write still ran. Whether the write reached the database is now taken from the check placed innermost on the client, which sends the write, instead of from the extension's own `query` call resolving; a write the extension never sent, or sent only after the operation failed, leaves the transaction to commit. Outside any transaction such a write stays unrecorded.
