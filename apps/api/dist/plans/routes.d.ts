import type { FastifyInstance } from 'fastify';
import { activePlanId } from './repo.js';
import type { Tx } from '../db/pool.js';
import type { PlanRow } from './repo.js';
export declare function registerPlanRoutes(app: FastifyInstance): void;
export declare function requireOwnedPlan(tx: Tx, userId: string, planIdRaw: unknown): Promise<PlanRow>;
export { activePlanId };
//# sourceMappingURL=routes.d.ts.map