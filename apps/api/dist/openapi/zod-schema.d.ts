/**
 * A small Zod -> JSON Schema (draft 2020-12) translator covering exactly the
 * constructs used by `@hi/contracts`. A general converter is a dependency we do
 * not need; anything unsupported degrades to `{}` rather than emitting a lie.
 */
import { type ZodTypeAny } from 'zod';
type Json = Record<string, unknown>;
export declare function zodToJsonSchema(schema: ZodTypeAny): Json;
export {};
//# sourceMappingURL=zod-schema.d.ts.map