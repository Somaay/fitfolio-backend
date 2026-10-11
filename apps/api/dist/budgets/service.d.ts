/**
 * Budget revision rules.
 *
 * A revision is an IMMUTABLE, COMPLETE six-month snapshot. The cross-row sum
 * (`sum(lines) <= total_minor`) cannot be a CHECK constraint — a CHECK sees one
 * row — so it is asserted here, in bigint, under a lock on the plan row. Doing the
 * sum in JS `number` would start losing paise above 2^53.
 */
import { type IsoDate } from '@hi/contracts';
import type { Tx } from '../db/pool.js';
import type { PlanRow } from '../plans/repo.js';
import { type RevisionRow } from './repo.js';
export interface RevisionInput {
    readonly total_minor: string;
    readonly effective_on?: string | undefined;
    readonly reason: string;
    readonly lines: readonly {
        category_code: string;
        allocated_minor: string;
    }[];
}
export interface ValidatedLines {
    readonly total: bigint;
    readonly lines: readonly {
        category_code: string;
        allocated_minor: bigint;
    }[];
}
/** Sum in bigint and reject duplicate categories before the unique index does. */
export declare function validateAllocations(input: RevisionInput): ValidatedLines;
/**
 * Revision 1 takes effect on the plan start date. Every later revision takes
 * effect today or later — NEVER backdated, because backdating silently rewrites
 * the utilisation history of an already-reported period.
 */
export declare function resolveEffectiveOn(plan: PlanRow, revision: number, requested: string | undefined, now?: Date): IsoDate;
/** Caller MUST already hold `SELECT ... FOR UPDATE` on the plan row. */
export declare function createRevisionLocked(tx: Tx, plan: PlanRow, input: RevisionInput, now?: Date): Promise<RevisionRow>;
//# sourceMappingURL=service.d.ts.map