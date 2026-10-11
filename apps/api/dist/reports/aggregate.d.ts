/**
 * Reporting aggregates.
 *
 * D-09: EVERY fact set is aggregated in its OWN statement before anything is
 * combined. A single query joining expenses to weights to activities multiplies
 * rows — three weigh-ins on the day of one payment would count that payment three
 * times — and silently inflates both spending and attendance. There is deliberately
 * no join across those tables anywhere in this file.
 *
 * All of these run inside ONE `REPEATABLE READ` snapshot, so spending, weight and
 * attendance are read from the same instant and cannot disagree.
 */
import { type IsoDate, type WeightObservation } from '@hi/contracts';
import type { Tx } from '../db/pool.js';
import type { PlanRow } from '../plans/repo.js';
export type Scope = 'total' | 'incremental';
/** Never past plan-local today, never past the plan's last included day. */
export declare function resolveAsOf(plan: PlanRow, requested: IsoDate | undefined, now?: Date): IsoDate;
/** Non-void scoped payments minus non-void scoped refunds, through the cutoff. */
export declare function netSpendMinor(tx: Tx, userId: string, planId: string, scope: Scope, asOf: IsoDate): Promise<bigint>;
/**
 * Spending relevant to attended sessions: the gym and trainer categories. Dividing
 * TOTAL spending by session count would price groceries per gym visit.
 */
export declare function sessionScopedSpendMinor(tx: Tx, userId: string, planId: string, scope: Scope, asOf: IsoDate): Promise<bigint>;
/** Weight observations only: no join, so repeated same-day readings stay one row each. */
export declare function weightObservations(tx: Tx, userId: string, planId: string, asOf: IsoDate): Promise<WeightObservation[]>;
export declare function latestMeasurementDate(tx: Tx, userId: string, planId: string, asOf: IsoDate): Promise<IsoDate | null>;
export declare function completedSessions(tx: Tx, userId: string, planId: string, asOf: IsoDate): Promise<number>;
/**
 * Sum of `max(0, expected_scoped - linked net scoped payments)` over PENDING
 * commitments only. A completed or cancelled commitment contributes zero, even if
 * a refund later left money outstanding: reopening it is an explicit user action.
 */
export declare function outstandingCommitmentMinor(tx: Tx, userId: string, planId: string, scope: Scope, asOf: IsoDate): Promise<bigint>;
//# sourceMappingURL=aggregate.d.ts.map