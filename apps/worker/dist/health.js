/**
 * Liveness and readiness for the worker.
 *
 * The worker has no HTTP surface of its own, but an orchestrator still needs to
 * know whether to restart it (liveness) and whether it is doing useful work
 * (readiness). The distinction is deliberate:
 *   /healthz — the event loop is alive. Cheap, no database access. A failing
 *              database must NOT cause a restart loop; restarting fixes nothing.
 *   /readyz  — the database is reachable AND the worker is not draining.
 * Neither endpoint returns any user data or any configuration value.
 */
import { createServer } from 'node:http';
export function startHealthServer(port, state, logger) {
    const server = createServer((request, response) => {
        const path = (request.url ?? '/').split('?')[0];
        const send = (status, body) => {
            const encoded = JSON.stringify(body);
            response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
            response.end(encoded);
        };
        if (path === '/healthz') {
            send(200, { status: 'ok', ...state.snapshot() });
            return;
        }
        if (path === '/readyz') {
            state.ready().then((result) => send(result.ok ? 200 : 503, { status: result.ok ? 'ready' : 'not_ready', detail: result.detail }), () => send(503, { status: 'not_ready', detail: 'readiness_check_failed' }));
            return;
        }
        send(404, { status: 'not_found' });
    });
    server.listen(port, '127.0.0.1', () => {
        logger.info({ port }, 'worker health server listening');
    });
    server.on('error', (error) => {
        logger.error({ err_code: error.code ?? 'unknown' }, 'health server error');
    });
    return server;
}
//# sourceMappingURL=health.js.map