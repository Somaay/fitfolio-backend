/** Plan row access. Every lookup is scoped to the session user; RLS is the backstop. */
import { type IsoDate } from '@hi/contracts';
import type { Tx } from '../db/pool.js';
export type PlanStatus = 'draft' | 'active' | 'completed' | 'cancelled';
export interface PlanRow {
    id: string;
    user_id: string;
    name: string;
    status: PlanStatus;
    start_date: IsoDate;
    end_date: IsoDate;
    timezone: string;
    currency_code: string;
    budget_scope: 'total' | 'incremental';
    baseline_weight_kg: string;
    target_weight_kg: string;
    daily_protein_target_g: string | null;
    daily_calorie_target: number | null;
    activated_at: Date | null;
    closed_at: Date | null;
    closed_on: IsoDate | null;
    version: number;
    created_at: Date;
    updated_at: Date;
}
/** Not owned and not existing are the SAME answer: 404. Anything else leaks existence. */
export declare function loadPlan(tx: Tx, userId: string, planId: string): Promise<PlanRow>;
/**
 * Serialises every cross-row plan invariant (activation, budget revisions,
 * lifecycle changes) against concurrent writers.
 */
export declare function lockPlan(tx: Tx, userId: string, planId: string): Promise<PlanRow>;
export declare function listPlans(tx: Tx, userId: string, limit: number, cursor: string | null): Promise<PlanRow[]>;
export declare function activePlanId(tx: Tx, userId: string): Promise<string | null>;
//# sourceMappingURL=repo.d.ts.map