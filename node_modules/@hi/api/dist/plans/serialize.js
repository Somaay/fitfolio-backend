export function summarizeBudget(effective, original, latest) {
    return {
        effective_revision_id: effective?.id ?? null,
        effective_revision: effective?.revision ?? null,
        effective_total_minor: effective?.total_minor ?? null,
        effective_on: effective?.effective_on ?? null,
        original_revision_id: original?.id ?? null,
        original_total_minor: original?.total_minor ?? null,
        latest_revision: latest?.revision ?? null,
        was_revised: (latest?.revision ?? 1) > (original?.revision ?? 1),
    };
}
export function serializePlan(plan, budget) {
    return {
        id: plan.id,
        name: plan.name,
        status: plan.status,
        start_date: plan.start_date,
        end_date: plan.end_date,
        timezone: plan.timezone,
        currency_code: plan.currency_code,
        budget_scope: plan.budget_scope,
        baseline_weight_kg: plan.baseline_weight_kg,
        target_weight_kg: plan.target_weight_kg,
        daily_calorie_target: plan.daily_calorie_target,
        daily_protein_target_g: plan.daily_protein_target_g,
        activated_at: plan.activated_at,
        closed_at: plan.closed_at,
        closed_on: plan.closed_on,
        version: plan.version,
        created_at: plan.created_at,
        updated_at: plan.updated_at,
        ...(budget ? { budget } : {}),
    };
}
export function serializeRevision(revision, originalRevisionNumber, effectiveRevisionId) {
    return {
        id: revision.id,
        revision: revision.revision,
        total_minor: revision.total_minor,
        effective_on: revision.effective_on,
        reason: revision.reason,
        created_at: revision.created_at,
        is_original: revision.revision === originalRevisionNumber,
        is_effective: revision.id === effectiveRevisionId,
        lines: revision.lines,
    };
}
//# sourceMappingURL=serialize.js.map