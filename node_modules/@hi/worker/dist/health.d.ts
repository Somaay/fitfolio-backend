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
import { type Server } from 'node:http';
import type { Logger } from 'pino';
export interface HealthState {
    ready(): Promise<{
        ok: boolean;
        detail: string;
    }>;
    snapshot(): Readonly<Record<string, unknown>>;
}
export declare function startHealthServer(port: number, state: HealthState, logger: Logger): Server;
//# sourceMappingURL=health.d.ts.map