/**
 * Audit trail.
 *
 * D-10: an audit row records WHO did WHAT to WHICH entity and nothing else.
 * No weight, no amount, no description, no note ever enters this table — the
 * audit log must be safe to retain longer than the data it describes.
 */
import type { Tx } from '../db/pool.js';

export type AuditAction =
  | 'plan.create' | 'plan.update' | 'plan.activate' | 'plan.complete' | 'plan.cancel'
  | 'budget_revision.create'
  | 'commitment.create' | 'commitment.update' | 'commitment.reopen' | 'commitment.generate'
  | 'expense.create' | 'expense.refund' | 'expense.correct' | 'expense.void'
  | 'weight.create' | 'weight.update' | 'weight.delete'
  | 'nutrition.upsert' | 'nutrition.delete'
  | 'activity.create' | 'activity.update' | 'activity.delete'
  | 'profile.update' | 'consent.record' | 'export.request'
  | 'account.deactivate';

export type AuditEntity =
  | 'plan' | 'budget_revision' | 'commitment' | 'expense' | 'weight_entry'
  | 'nutrition_day' | 'activity_entry' | 'user' | 'consent_event' | 'account_export';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function recordAudit(
  tx: Tx,
  input: {
    userId: string;
    action: AuditAction;
    entityType: AuditEntity;
    entityId?: string | null;
    requestId?: string | null;
    actorType?: 'user' | 'system';
  },
): Promise<void> {
  // request.id is only a uuid when the client supplied one; the column is uuid.
  const requestId = input.requestId && UUID.test(input.requestId) ? input.requestId : null;
  await tx.query(
    `INSERT INTO audit_events (user_id, actor_type, action, entity_type, entity_id, request_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [input.userId, input.actorType ?? 'user', input.action, input.entityType, input.entityId ?? null, requestId],
  );
}
