import { categoryCode, categoryId } from '../db/categories.js';
export async function nextRevisionNumber(tx, userId, planId) {
    const { rows } = await tx.query(`SELECT coalesce(max(revision), 0) + 1 AS next
       FROM budget_revisions WHERE user_id = $1 AND plan_id = $2`, [userId, planId]);
    return rows[0]?.next ?? 1;
}
export async function insertRevision(tx, input) {
    const { rows } = await tx.query(`INSERT INTO budget_revisions (user_id, plan_id, revision, total_minor, effective_on, reason)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, revision, total_minor, effective_on, reason, created_at`, [input.userId, input.planId, input.revision, input.totalMinor.toString(10), input.effectiveOn, input.reason]);
    const header = rows[0];
    if (!header)
        throw new Error('budget revision insert returned no row');
    // Header and every line in the same transaction: a revision is a COMPLETE snapshot.
    for (const line of input.lines) {
        await tx.query(`INSERT INTO budget_lines (user_id, plan_id, revision_id, category_id, allocated_minor)
       VALUES ($1, $2, $3, $4, $5)`, [input.userId, input.planId, header.id, await categoryId(tx, line.category_code), line.allocated_minor.toString(10)]);
    }
    return header;
}
export async function loadRevisionLines(tx, userId, revisionIds) {
    const map = new Map();
    if (revisionIds.length === 0)
        return map;
    const { rows } = await tx.query(`SELECT revision_id, category_id, allocated_minor
       FROM budget_lines
      WHERE user_id = $1 AND revision_id = ANY($2::uuid[])
      ORDER BY category_id`, [userId, revisionIds]);
    for (const row of rows) {
        const bucket = map.get(row.revision_id) ?? [];
        bucket.push({ category_code: await categoryCode(tx, row.category_id), allocated_minor: row.allocated_minor });
        map.set(row.revision_id, bucket);
    }
    return map;
}
export async function listRevisions(tx, userId, planId) {
    const { rows } = await tx.query(`SELECT id, revision, total_minor, effective_on, reason, created_at
       FROM budget_revisions WHERE user_id = $1 AND plan_id = $2 ORDER BY revision ASC`, [userId, planId]);
    const lines = await loadRevisionLines(tx, userId, rows.map((r) => r.id));
    return rows.map((r) => ({ ...r, lines: lines.get(r.id) ?? [] }));
}
/**
 * The revision in force on `asOf`. Ties on effective_on break on the HIGHEST
 * revision: two revisions dated the same day means the later edit wins.
 */
export async function effectiveRevision(tx, userId, planId, asOf) {
    const { rows } = await tx.query(`SELECT id, revision, total_minor, effective_on, reason, created_at
       FROM budget_revisions
      WHERE user_id = $1 AND plan_id = $2 AND effective_on <= $3::date
      ORDER BY effective_on DESC, revision DESC
      LIMIT 1`, [userId, planId, asOf]);
    return rows[0] ?? null;
}
/** Revision 1: the original comparison, which a later increase must never erase. */
export async function originalRevision(tx, userId, planId) {
    const { rows } = await tx.query(`SELECT id, revision, total_minor, effective_on, reason, created_at
       FROM budget_revisions
      WHERE user_id = $1 AND plan_id = $2
      ORDER BY revision ASC LIMIT 1`, [userId, planId]);
    return rows[0] ?? null;
}
export async function latestRevision(tx, userId, planId) {
    const { rows } = await tx.query(`SELECT id, revision, total_minor, effective_on, reason, created_at
       FROM budget_revisions
      WHERE user_id = $1 AND plan_id = $2
      ORDER BY revision DESC LIMIT 1`, [userId, planId]);
    return rows[0] ?? null;
}
//# sourceMappingURL=repo.js.map