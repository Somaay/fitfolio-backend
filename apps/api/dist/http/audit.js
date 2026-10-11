const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function recordAudit(tx, input) {
    // request.id is only a uuid when the client supplied one; the column is uuid.
    const requestId = input.requestId && UUID.test(input.requestId) ? input.requestId : null;
    await tx.query(`INSERT INTO audit_events (user_id, actor_type, action, entity_type, entity_id, request_id)
     VALUES ($1, $2, $3, $4, $5, $6)`, [input.userId, input.actorType ?? 'user', input.action, input.entityType, input.entityId ?? null, requestId]);
}
//# sourceMappingURL=audit.js.map