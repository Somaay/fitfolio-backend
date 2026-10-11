import { currentUser } from '../auth/require-auth.js';
import { readIdempotencyKey, runIdempotent } from './idempotency.js';
/**
 * Reserve the key, mutate and store the replay body — all in ONE transaction, so
 * a failure rolls the reservation back with the work and a retry can succeed.
 */
export async function mutate(app, request, reply, routeKey, run) {
    const user = currentUser(request);
    const key = readIdempotencyKey(request.headers);
    const { outcome, replayed } = await app.db.withUserTransaction(user.userId, (tx) => runIdempotent(tx, { userId: user.userId, route: routeKey, key, body: request.body ?? null }, () => run({ tx, user, requestId: request.id })));
    if (replayed)
        void reply.header('Idempotent-Replay', 'true');
    void reply.code(outcome.status);
    await reply.send(outcome.body);
}
/** A mutation with no idempotency semantics (PATCH/DELETE guarded by If-Match). */
export async function transact(app, request, run) {
    const user = currentUser(request);
    return app.db.withUserTransaction(user.userId, (tx) => run({ tx, user, requestId: request.id }));
}
export async function readOnly(app, request, run) {
    const user = currentUser(request);
    return app.db.withUserTransaction(user.userId, (tx) => run({ tx, user, requestId: request.id }));
}
/** Reporting: one REPEATABLE READ snapshot for every fact set. */
export async function snapshot(app, request, run) {
    const user = currentUser(request);
    return app.db.withReadSnapshot(user.userId, (tx) => run({ tx, user, requestId: request.id }));
}
//# sourceMappingURL=handlers.js.map