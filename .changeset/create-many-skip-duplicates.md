---
"@kuruwic/prisma-audit": patch
---

Record no create for a row a `createMany` with `skipDuplicates` skipped because a row with its key already existed; such a row read back as the existing row and was recorded as created. When rows of `data` give key fields themselves, the extension reads the rows holding those keys before the write, on the operation's client, and records none of the rows read back under those keys. The other rows read back are recorded when their number matches the count the write returns; otherwise only the rows whose keys the extension generated are recorded, and the rest are reported as `row-identification`. Keys the extension generates are not read: they are taken to be held by no row. A `createMany` without `skipDuplicates`, or whose data gives no key field, reads nothing before the write.
