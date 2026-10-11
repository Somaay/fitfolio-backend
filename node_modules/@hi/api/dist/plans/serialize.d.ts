/** Wire shapes for plans. Money is always a decimal integer STRING in minor units. */
import type { IsoDate } from '@hi/contracts';
import type { RevisionRow, RevisionWithLines } from '../budgets/repo.js';
import type { PlanRow } from './repo.js';
export interface BudgetSummary {
    effective_revision_id: string | null;
    effective_revision: number | null;
    effective_total_minor: string | null;
    effective_on: IsoDate | null;
    original_revision_id: string | null;
    original_total_minor: string | null;
    latest_revision: number | null;
    was_revised: boolean;
}
export declare function summarizeBudget(effective: RevisionRow | null, original: RevisionRow | null, latest: RevisionRow | null): BudgetSummary;
export declare function serializePlan(plan: PlanRow, budget?: BudgetSummary): Record<string, unknown>;
export declare function serializeRevision(revision: RevisionWithLines, originalRevisionNumber: number, effectiveRevisionId: string | null): Record<string, unknown>;
//# sourceMappingURL=serialize.d.ts.map