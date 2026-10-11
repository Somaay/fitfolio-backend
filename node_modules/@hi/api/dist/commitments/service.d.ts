import { type CategoryCode, type CreateCommitmentBody, type IsoDate } from '@hi/contracts';
import type { Tx } from '../db/pool.js';
import type { PlanRow } from '../plans/repo.js';
import { type CommitmentRow } from './repo.js';
export declare function createCommitment(tx: Tx, plan: PlanRow, body: CreateCommitmentBody, requestId: string): Promise<CommitmentRow>;
export interface CommitmentPatch {
    label?: string;
    due_on?: string;
    expected_minor?: string;
    attributable_minor?: string;
    expected_sessions?: number | null;
    status?: 'pending' | 'completed' | 'cancelled';
}
export declare function updateCommitment(tx: Tx, plan: PlanRow, commitmentId: string, expectedVersion: number, patch: CommitmentPatch, requestId: string): Promise<CommitmentRow>;
export interface GenerateInput {
    category_code: CategoryCode;
    label: string;
    amount_minor: string;
    attributable_minor: string;
    cadence: 'monthly' | 'weekly';
    first_due_on: string;
    occurrences: number;
    expected_sessions?: number | null;
}
/**
 * Stable across retries AND across separate requests with the same parameters:
 * the key hashes the whole expansion definition plus the occurrence index, so
 * re-running the same generation is a genuine no-op, not a duplicate set.
 */
export declare function generationKey(input: GenerateInput, index: number): string;
export declare function occurrenceDates(input: GenerateInput): IsoDate[];
export declare function generateCommitments(tx: Tx, plan: PlanRow, input: GenerateInput, requestId: string): Promise<{
    created: CommitmentRow[];
    skipped: number;
}>;
/**
 * A gym commitment must not receive a trainer payment. The composite foreign key
 * binds a commitment to the same user and plan but NOT to the same category, so
 * the category check has to happen here.
 */
export declare function assertCategoryCompatible(tx: Tx, commitment: CommitmentRow, paymentCategoryId: number, field?: string): Promise<void>;
//# sourceMappingURL=service.d.ts.map