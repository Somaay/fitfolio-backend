/** Transaction + idempotency plumbing shared by every mutating route. */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { currentUser } from '../auth/require-auth.js';
import type { Tx } from '../db/pool.js';
import type { AuthenticatedUser } from '../types.js';
import { readIdempotencyKey, runIdempotent, type IdempotentOutcome } from './idempotency.js';

export interface MutationContext {
  readonly tx: Tx;
  readonly user: AuthenticatedUser;
  readonly requestId: string;
}

/**
 * Reserve the key, mutate and store the replay body — all in ONE transaction, so
 * a failure rolls the reservation back with the work and a retry can succeed.
 */
export async function mutate(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  routeKey: string,
  run: (ctx: MutationContext) => Promise<IdempotentOutcome>,
): Promise<void> {
  const user = currentUser(request);
  const key = readIdempotencyKey(request.headers as Record<string, unknown>);

  const { outcome, replayed } = await app.db.withUserTransaction(user.userId, (tx) =>
    runIdempotent(
      tx,
      { userId: user.userId, route: routeKey, key, body: request.body ?? null },
      () => run({ tx, user, requestId: request.id }),
    ),
  );

  if (replayed) void reply.header('Idempotent-Replay', 'true');
  void reply.code(outcome.status);
  await reply.send(outcome.body);
}

/** A mutation with no idempotency semantics (PATCH/DELETE guarded by If-Match). */
export async function transact<T>(
  app: FastifyInstance,
  request: FastifyRequest,
  run: (ctx: MutationContext) => Promise<T>,
): Promise<T> {
  const user = currentUser(request);
  return app.db.withUserTransaction(user.userId, (tx) => run({ tx, user, requestId: request.id }));
}

export async function readOnly<T>(
  app: FastifyInstance,
  request: FastifyRequest,
  run: (ctx: MutationContext) => Promise<T>,
): Promise<T> {
  const user = currentUser(request);
  return app.db.withUserTransaction(user.userId, (tx) => run({ tx, user, requestId: request.id }));
}

/** Reporting: one REPEATABLE READ snapshot for every fact set. */
export async function snapshot<T>(
  app: FastifyInstance,
  request: FastifyRequest,
  run: (ctx: MutationContext) => Promise<T>,
): Promise<T> {
  const user = currentUser(request);
  return app.db.withReadSnapshot(user.userId, (tx) => run({ tx, user, requestId: request.id }));
}
