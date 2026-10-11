/** Schema parsing that always produces the shared error contract. */
import type { ZodTypeAny, z } from 'zod';
import type { ZodError } from 'zod';
import { ApiError } from '@hi/contracts';
import { zodToApiError } from './errors.js';

export function parseOrThrow<S extends ZodTypeAny>(
  schema: S,
  value: unknown,
  where: 'body' | 'query' | 'params' | 'headers',
): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw zodToApiError(result.error as ZodError, where);
  return result.data as z.infer<S>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * An id that is not even a uuid cannot be owned, so it is a 404 — exactly the
 * same answer as a uuid belonging to someone else. Never distinguish the two.
 */
export function requireUuidParam(value: unknown, _name: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw ApiError.notFound('resource');
  return value;
}
