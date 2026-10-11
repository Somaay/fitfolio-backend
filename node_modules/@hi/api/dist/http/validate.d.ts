/** Schema parsing that always produces the shared error contract. */
import type { ZodTypeAny, z } from 'zod';
export declare function parseOrThrow<S extends ZodTypeAny>(schema: S, value: unknown, where: 'body' | 'query' | 'params' | 'headers'): z.infer<S>;
/**
 * An id that is not even a uuid cannot be owned, so it is a 404 — exactly the
 * same answer as a uuid belonging to someone else. Never distinguish the two.
 */
export declare function requireUuidParam(value: unknown, _name: string): string;
//# sourceMappingURL=validate.d.ts.map