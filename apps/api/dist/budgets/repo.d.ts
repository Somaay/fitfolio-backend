/** Budget revisions are append-only: the API role holds no UPDATE or DELETE grant. */
import type { IsoDate } from '@hi/contracts';
import type { Tx } from '../db/pool.js';
export interface RevisionRow {
    id: string;
    revision: number;
    total_minor: string;
    effective_on: IsoDate;
    reason: string;
    created_at: Date;
}
export interface RevisionLine {
    category_code: string;
    allocated_minor: string;
}
export interface RevisionWithLines extends RevisionRow {
    lines: RevisionLine[];
}
export declare function nextRevisionNumber(tx: Tx, userId: string, planId: string): Promise<number>;
export declare function insertRevision(tx: Tx, input: {
    userId: string;
    planId: string;
    revision: number;
    totalMinor: bigint;
    effectiveOn: IsoDate;
    reason: string;
    lines: readonly {
        category_code: string;
        allocated_minor: bigint;
    }[];
}): Promise<RevisionRow>;
export declare function loadRevisionLines(tx: Tx, userId: string, revisionIds: readonly string[]): Promise<Map<string, RevisionLine[]>>;
export declare function listRevisions(tx: Tx, userId: string, planId: string): Promise<RevisionWithLines[]>;
/**
 * The revision in force on `asOf`. Ties on effective_on break on the HIGHEST
 * revision: two revisions dated the same day means the later edit wins.
 */
export declare function effectiveRevision(tx: Tx, userId: string, planId: string, asOf: IsoDate): Promise<RevisionRow | null>;
/** Revision 1: the original comparison, which a later increase must never erase. */
export declare function originalRevision(tx: Tx, userId: string, planId: string): Promise<RevisionRow | null>;
export declare function latestRevision(tx: Tx, userId: string, planId: string): Promise<RevisionRow | null>;
//# sourceMappingURL=repo.d.ts.map