/** Commitments: unpaid dated forecasts, and the outstanding amount they still imply. */
import { type IsoDate } from '@hi/contracts';
import type { Tx } from '../db/pool.js';
export type CommitmentStatus = 'pending' | 'completed' | 'cancelled';
export interface CommitmentRow {
    id: string;
    user_id: string;
    plan_id: string;
    category_id: number;
    label: string;
    due_on: IsoDate;
    expected_minor: string;
    attributable_minor: string;
    session_model: 'unlimited' | 'sessions';
    expected_sessions: number | null;
    status: CommitmentStatus;
    reopened_at: Date | null;
    generation_key: string | null;
    version: number;
    created_at: Date;
    updated_at: Date;
}
export declare const COMMITMENT_COLUMNS = "id, user_id, plan_id, category_id, label, due_on, expected_minor,\n  attributable_minor, session_model, expected_sessions, status, reopened_at, generation_key,\n  version, created_at, updated_at";
export declare function loadCommitment(tx: Tx, userId: string, planId: string, commitmentId: string): Promise<CommitmentRow>;
export declare function lockCommitment(tx: Tx, userId: string, planId: string, commitmentId: string): Promise<CommitmentRow>;
export declare function listCommitments(tx: Tx, userId: string, planId: string, limit: number, cursor: string | null, range: {
    from?: IsoDate;
    to?: IsoDate;
}): Promise<CommitmentRow[]>;
/**
 * Net scoped payments already linked to each commitment.
 *
 * Aggregated on its OWN, then joined by the caller. Joining commitments to
 * expenses and to activities in one statement multiplies rows and inflates both.
 */
export declare function linkedNetByCommitment(tx: Tx, userId: string, planId: string, scope: 'total' | 'incremental', asOf: IsoDate | null): Promise<Map<string, bigint>>;
/** Completed and cancelled commitments contribute ZERO outstanding forecast. */
export declare function outstandingMinor(commitment: Pick<CommitmentRow, 'status' | 'expected_minor' | 'attributable_minor'>, scope: 'total' | 'incremental', linkedNet: bigint): bigint;
export declare function serializeCommitment(tx: Tx, row: CommitmentRow, scope: 'total' | 'incremental', linkedNet: bigint): Promise<Record<string, unknown>>;
//# sourceMappingURL=repo.d.ts.map