---
"@kuruwic/db-audit-core": major
"@kuruwic/prisma-audit": major
---

Redact the enriched contexts and the request context as the states are, so a secret in a context is no longer stored in clear.

- Breaking: `actorContext`, `entityContext`, `aggregateContext` and `requestContext` mask the built-in sensitive fields (`password`, `token`, `apiKey` and the like) and `redactFields` at any depth, after the serializers ran, as `before`, `after` and `changes` do. Before, they were stored as the enrichers and the context provider returned them. A field that a context needs in clear must not share a name with a sensitive field or one in `redactFields`.
- Only the keys of the structure the serializers output are masked: a serializer that turns an object into a string hides the keys inside it, which are stored in clear.
