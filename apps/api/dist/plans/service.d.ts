import type { CreatePlanBody } from '@hi/contracts';
import type { Tx } from '../db/pool.js';
import { loadPlan, lockPlan, type PlanRow } from './repo.js';
export declare function createPlan(tx: Tx, userId: string, body: CreatePlanBody, requestId: string): Promise<PlanRow>;
export declare function updateDraftPlan(tx: Tx, userId: string, planId: string, expectedVersion: number, patch: Record<string, unknown>, requestId: string): Promise<PlanRow>;
export declare function activatePlan(tx: Tx, userId: string, planId: string, requestId: string, now?: Date): Promise<PlanRow>;
export declare function completePlan(tx: Tx, userId: string, planId: string, requestId: string, now?: Date): Promise<PlanRow>;
export declare function cancelPlan(tx: Tx, userId: string, planId: string, requestId: string, now?: Date): Promise<PlanRow>;
export { loadPlan, lockPlan };
//# sourceMappingURL=service.d.ts.map