/**
 * Shared request/response schemas. The API validates with these and the web app
 * imports the inferred types, so a field cannot be renamed on one side only.
 */
import { z } from 'zod';
/** Money crosses the wire as a decimal integer string in MINOR units. */
export declare const MinorAmount: z.ZodString;
export declare const SignedMinorAmount: z.ZodString;
export declare const IsoDateSchema: z.ZodString;
export declare const WeightKgSchema: z.ZodString;
export declare const TimeZoneSchema: z.ZodEffects<z.ZodString, string, string>;
export declare const CurrencySchema: z.ZodEnum<[string, ...string[]]>;
export declare const CategoryCodeSchema: z.ZodEnum<["gym", "trainer", "groceries", "prepared_meals", "supplements", "other"]>;
export declare const BudgetScopeSchema: z.ZodEnum<["total", "incremental"]>;
export declare const Uuid: z.ZodString;
export type CategoryCode = z.infer<typeof CategoryCodeSchema>;
export declare const UpdateProfileRequest: z.ZodObject<{
    display_name: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    timezone: z.ZodOptional<z.ZodEffects<z.ZodString, string, string>>;
    weight_unit: z.ZodOptional<z.ZodEnum<["kg", "lb"]>>;
    notification_opt_in: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    display_name?: string | null | undefined;
    timezone?: string | undefined;
    weight_unit?: "kg" | "lb" | undefined;
    notification_opt_in?: boolean | undefined;
}, {
    display_name?: string | null | undefined;
    timezone?: string | undefined;
    weight_unit?: "kg" | "lb" | undefined;
    notification_opt_in?: boolean | undefined;
}>;
export declare const ConsentRequest: z.ZodObject<{
    purpose: z.ZodEnum<["essential_processing", "weekly_reminders", "product_updates"]>;
    policy_version: z.ZodString;
    action: z.ZodEnum<["granted", "revoked"]>;
}, "strip", z.ZodTypeAny, {
    purpose: "essential_processing" | "weekly_reminders" | "product_updates";
    policy_version: string;
    action: "granted" | "revoked";
}, {
    purpose: "essential_processing" | "weekly_reminders" | "product_updates";
    policy_version: string;
    action: "granted" | "revoked";
}>;
export declare const CreatePlanRequest: z.ZodObject<{
    name: z.ZodString;
    start_date: z.ZodString;
    timezone: z.ZodEffects<z.ZodString, string, string>;
    currency_code: z.ZodEnum<[string, ...string[]]>;
    budget_scope: z.ZodEnum<["total", "incremental"]>;
    baseline_weight_kg: z.ZodString;
    target_weight_kg: z.ZodString;
    daily_calorie_target: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    daily_protein_target_g: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    budget: z.ZodObject<{
        total_minor: z.ZodString;
        reason: z.ZodDefault<z.ZodString>;
        lines: z.ZodDefault<z.ZodArray<z.ZodObject<{
            category_code: z.ZodEnum<["gym", "trainer", "groceries", "prepared_meals", "supplements", "other"]>;
            allocated_minor: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            category_code: "gym" | "trainer" | "groceries" | "prepared_meals" | "supplements" | "other";
            allocated_minor: string;
        }, {
            category_code: "gym" | "trainer" | "groceries" | "prepared_meals" | "supplements" | "other";
            allocated_minor: string;
        }>, "many">>;
    }, "strip", z.ZodTypeAny, {
        total_minor: string;
        reason: string;
        lines: {
            category_code: "gym" | "trainer" | "groceries" | "prepared_meals" | "supplements" | "other";
            allocated_minor: string;
        }[];
    }, {
        total_minor: string;
        reason?: string | undefined;
        lines?: {
            category_code: "gym" | "trainer" | "groceries" | "prepared_meals" | "supplements" | "other";
            allocated_minor: string;
        }[] | undefined;
    }>;
}, "strip", z.ZodTypeAny, {
    timezone: string;
    name: string;
    start_date: string;
    currency_code: string;
    budget_scope: "total" | "incremental";
    baseline_weight_kg: string;
    target_weight_kg: string;
    budget: {
        total_minor: string;
        reason: string;
        lines: {
            category_code: "gym" | "trainer" | "groceries" | "prepared_meals" | "supplements" | "other";
            allocated_minor: string;
        }[];
    };
    daily_calorie_target?: number | null | undefined;
    daily_protein_target_g?: string | null | undefined;
}, {
    timezone: string;
    name: string;
    start_date: string;
    currency_code: string;
    budget_scope: "total" | "incremental";
    baseline_weight_kg: string;
    target_weight_kg: string;
    budget: {
        total_minor: string;
        reason?: string | undefined;
        lines?: {
            category_code: "gym" | "trainer" | "groceries" | "prepared_meals" | "supplements" | "other";
            allocated_minor: string;
        }[] | undefined;
    };
    daily_calorie_target?: number | null | undefined;
    daily_protein_target_g?: string | null | undefined;
}>;
export declare const UpdatePlanRequest: z.ZodObject<{
    name: z.ZodOptional<z.ZodString>;
    start_date: z.ZodOptional<z.ZodString>;
    timezone: z.ZodOptional<z.ZodEffects<z.ZodString, string, string>>;
    currency_code: z.ZodOptional<z.ZodEnum<[string, ...string[]]>>;
    budget_scope: z.ZodOptional<z.ZodEnum<["total", "incremental"]>>;
    baseline_weight_kg: z.ZodOptional<z.ZodString>;
    target_weight_kg: z.ZodOptional<z.ZodString>;
    daily_calorie_target: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    daily_protein_target_g: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, "strip", z.ZodTypeAny, {
    timezone?: string | undefined;
    name?: string | undefined;
    start_date?: string | undefined;
    currency_code?: string | undefined;
    budget_scope?: "total" | "incremental" | undefined;
    baseline_weight_kg?: string | undefined;
    target_weight_kg?: string | undefined;
    daily_calorie_target?: number | null | undefined;
    daily_protein_target_g?: string | null | undefined;
}, {
    timezone?: string | undefined;
    name?: string | undefined;
    start_date?: string | undefined;
    currency_code?: string | undefined;
    budget_scope?: "total" | "incremental" | undefined;
    baseline_weight_kg?: string | undefined;
    target_weight_kg?: string | undefined;
    daily_calorie_target?: number | null | undefined;
    daily_protein_target_g?: string | null | undefined;
}>;
export declare const BudgetRevisionRequest: z.ZodObject<{
    total_minor: z.ZodString;
    effective_on: z.ZodOptional<z.ZodString>;
    reason: z.ZodString;
    lines: z.ZodArray<z.ZodObject<{
        category_code: z.ZodEnum<["gym", "trainer", "groceries", "prepared_meals", "supplements", "other"]>;
        allocated_minor: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        category_code: "gym" | "trainer" | "groceries" | "prepared_meals" | "supplements" | "other";
        allocated_minor: string;
    }, {
        category_code: "gym" | "trainer" | "groceries" | "prepared_meals" | "supplements" | "other";
        allocated_minor: string;
    }>, "many">;
}, "strip", z.ZodTypeAny, {
    total_minor: string;
    reason: string;
    lines: {
        category_code: "gym" | "trainer" | "groceries" | "prepared_meals" | "supplements" | "other";
        allocated_minor: string;
    }[];
    effective_on?: string | undefined;
}, {
    total_minor: string;
    reason: string;
    lines: {
        category_code: "gym" | "trainer" | "groceries" | "prepared_meals" | "supplements" | "other";
        allocated_minor: string;
    }[];
    effective_on?: string | undefined;
}>;
export declare const CreateCommitmentRequest: z.ZodObject<{
    category_code: z.ZodEnum<["gym", "trainer", "groceries", "prepared_meals", "supplements", "other"]>;
    label: z.ZodString;
    due_on: z.ZodString;
    expected_minor: z.ZodString;
    attributable_minor: z.ZodString;
    expected_sessions: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
}, "strip", z.ZodTypeAny, {
    category_code: "gym" | "trainer" | "groceries" | "prepared_meals" | "supplements" | "other";
    label: string;
    due_on: string;
    expected_minor: string;
    attributable_minor: string;
    expected_sessions?: number | null | undefined;
}, {
    category_code: "gym" | "trainer" | "groceries" | "prepared_meals" | "supplements" | "other";
    label: string;
    due_on: string;
    expected_minor: string;
    attributable_minor: string;
    expected_sessions?: number | null | undefined;
}>;
export declare const UpdateCommitmentRequest: z.ZodObject<{
    label: z.ZodOptional<z.ZodString>;
    due_on: z.ZodOptional<z.ZodString>;
    expected_minor: z.ZodOptional<z.ZodString>;
    attributable_minor: z.ZodOptional<z.ZodString>;
    expected_sessions: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    status: z.ZodOptional<z.ZodEnum<["pending", "completed", "cancelled"]>>;
}, "strip", z.ZodTypeAny, {
    status?: "pending" | "completed" | "cancelled" | undefined;
    label?: string | undefined;
    due_on?: string | undefined;
    expected_minor?: string | undefined;
    attributable_minor?: string | undefined;
    expected_sessions?: number | null | undefined;
}, {
    status?: "pending" | "completed" | "cancelled" | undefined;
    label?: string | undefined;
    due_on?: string | undefined;
    expected_minor?: string | undefined;
    attributable_minor?: string | undefined;
    expected_sessions?: number | null | undefined;
}>;
/** Idempotent expansion of a recurring estimate into dated commitments. */
export declare const GenerateCommitmentsRequest: z.ZodObject<{
    category_code: z.ZodEnum<["gym", "trainer", "groceries", "prepared_meals", "supplements", "other"]>;
    label: z.ZodString;
    amount_minor: z.ZodString;
    attributable_minor: z.ZodString;
    cadence: z.ZodEnum<["monthly", "weekly"]>;
    first_due_on: z.ZodString;
    occurrences: z.ZodNumber;
    expected_sessions: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
}, "strip", z.ZodTypeAny, {
    category_code: "gym" | "trainer" | "groceries" | "prepared_meals" | "supplements" | "other";
    label: string;
    attributable_minor: string;
    amount_minor: string;
    cadence: "monthly" | "weekly";
    first_due_on: string;
    occurrences: number;
    expected_sessions?: number | null | undefined;
}, {
    category_code: "gym" | "trainer" | "groceries" | "prepared_meals" | "supplements" | "other";
    label: string;
    attributable_minor: string;
    amount_minor: string;
    cadence: "monthly" | "weekly";
    first_due_on: string;
    occurrences: number;
    expected_sessions?: number | null | undefined;
}>;
export declare const CreateExpenseRequest: z.ZodObject<{
    category_code: z.ZodEnum<["gym", "trainer", "groceries", "prepared_meals", "supplements", "other"]>;
    paid_on: z.ZodString;
    amount_minor: z.ZodString;
    attributable_minor: z.ZodString;
    description: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    commitment_id: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, "strip", z.ZodTypeAny, {
    category_code: "gym" | "trainer" | "groceries" | "prepared_meals" | "supplements" | "other";
    attributable_minor: string;
    amount_minor: string;
    paid_on: string;
    description?: string | null | undefined;
    commitment_id?: string | null | undefined;
}, {
    category_code: "gym" | "trainer" | "groceries" | "prepared_meals" | "supplements" | "other";
    attributable_minor: string;
    amount_minor: string;
    paid_on: string;
    description?: string | null | undefined;
    commitment_id?: string | null | undefined;
}>;
export declare const CreateRefundRequest: z.ZodObject<{
    refunded_on: z.ZodString;
    amount_minor: z.ZodString;
    attributable_minor: z.ZodString;
    description: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, "strip", z.ZodTypeAny, {
    attributable_minor: string;
    amount_minor: string;
    refunded_on: string;
    description?: string | null | undefined;
}, {
    attributable_minor: string;
    amount_minor: string;
    refunded_on: string;
    description?: string | null | undefined;
}>;
/** Atomic void-and-replace. Never model a data-entry fix as a refund. */
export declare const CorrectExpenseRequest: z.ZodObject<{
    reason: z.ZodString;
    replacement: z.ZodObject<{
        category_code: z.ZodEnum<["gym", "trainer", "groceries", "prepared_meals", "supplements", "other"]>;
        paid_on: z.ZodString;
        amount_minor: z.ZodString;
        attributable_minor: z.ZodString;
        description: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        commitment_id: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    }, "strip", z.ZodTypeAny, {
        category_code: "gym" | "trainer" | "groceries" | "prepared_meals" | "supplements" | "other";
        attributable_minor: string;
        amount_minor: string;
        paid_on: string;
        description?: string | null | undefined;
        commitment_id?: string | null | undefined;
    }, {
        category_code: "gym" | "trainer" | "groceries" | "prepared_meals" | "supplements" | "other";
        attributable_minor: string;
        amount_minor: string;
        paid_on: string;
        description?: string | null | undefined;
        commitment_id?: string | null | undefined;
    }>;
}, "strip", z.ZodTypeAny, {
    reason: string;
    replacement: {
        category_code: "gym" | "trainer" | "groceries" | "prepared_meals" | "supplements" | "other";
        attributable_minor: string;
        amount_minor: string;
        paid_on: string;
        description?: string | null | undefined;
        commitment_id?: string | null | undefined;
    };
}, {
    reason: string;
    replacement: {
        category_code: "gym" | "trainer" | "groceries" | "prepared_meals" | "supplements" | "other";
        attributable_minor: string;
        amount_minor: string;
        paid_on: string;
        description?: string | null | undefined;
        commitment_id?: string | null | undefined;
    };
}>;
export declare const CreateWeightRequest: z.ZodObject<{
    measured_at: z.ZodString;
    weight_kg: z.ZodString;
}, "strip", z.ZodTypeAny, {
    measured_at: string;
    weight_kg: string;
}, {
    measured_at: string;
    weight_kg: string;
}>;
export declare const UpdateWeightRequest: z.ZodObject<{
    measured_at: z.ZodOptional<z.ZodString>;
    weight_kg: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    measured_at?: string | undefined;
    weight_kg?: string | undefined;
}, {
    measured_at?: string | undefined;
    weight_kg?: string | undefined;
}>;
/** A missing field means UNKNOWN; an explicit 0 means zero. Hence `.nullable()`. */
export declare const PutNutritionRequest: z.ZodEffects<z.ZodObject<{
    calories: z.ZodNullable<z.ZodNumber>;
    protein_g: z.ZodNullable<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    calories: number | null;
    protein_g: string | null;
}, {
    calories: number | null;
    protein_g: string | null;
}>, {
    calories: number | null;
    protein_g: string | null;
}, {
    calories: number | null;
    protein_g: string | null;
}>;
export declare const CreateActivityRequest: z.ZodObject<{
    occurred_at: z.ZodString;
    kind: z.ZodEnum<["gym", "trainer", "home_workout", "other"]>;
    status: z.ZodEnum<["completed", "missed"]>;
    duration_minutes: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    commitment_id: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, "strip", z.ZodTypeAny, {
    status: "completed" | "missed";
    occurred_at: string;
    kind: "gym" | "trainer" | "other" | "home_workout";
    commitment_id?: string | null | undefined;
    duration_minutes?: number | null | undefined;
}, {
    status: "completed" | "missed";
    occurred_at: string;
    kind: "gym" | "trainer" | "other" | "home_workout";
    commitment_id?: string | null | undefined;
    duration_minutes?: number | null | undefined;
}>;
export declare const UpdateActivityRequest: z.ZodObject<{
    occurred_at: z.ZodOptional<z.ZodString>;
    kind: z.ZodOptional<z.ZodEnum<["gym", "trainer", "home_workout", "other"]>>;
    status: z.ZodOptional<z.ZodEnum<["completed", "missed"]>>;
    duration_minutes: z.ZodOptional<z.ZodOptional<z.ZodNullable<z.ZodNumber>>>;
    commitment_id: z.ZodOptional<z.ZodOptional<z.ZodNullable<z.ZodString>>>;
}, "strip", z.ZodTypeAny, {
    status?: "completed" | "missed" | undefined;
    commitment_id?: string | null | undefined;
    occurred_at?: string | undefined;
    kind?: "gym" | "trainer" | "other" | "home_workout" | undefined;
    duration_minutes?: number | null | undefined;
}, {
    status?: "completed" | "missed" | undefined;
    commitment_id?: string | null | undefined;
    occurred_at?: string | undefined;
    kind?: "gym" | "trainer" | "other" | "home_workout" | undefined;
    duration_minutes?: number | null | undefined;
}>;
export declare const AsOfQuery: z.ZodObject<{
    as_of: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    as_of?: string | undefined;
}, {
    as_of?: string | undefined;
}>;
export declare const PaginationQuery: z.ZodObject<{
    cursor: z.ZodOptional<z.ZodString>;
    limit: z.ZodDefault<z.ZodNumber>;
    from: z.ZodOptional<z.ZodString>;
    to: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    limit: number;
    cursor?: string | undefined;
    from?: string | undefined;
    to?: string | undefined;
}, {
    cursor?: string | undefined;
    limit?: number | undefined;
    from?: string | undefined;
    to?: string | undefined;
}>;
export type CreatePlanBody = z.infer<typeof CreatePlanRequest>;
export type CreateExpenseBody = z.infer<typeof CreateExpenseRequest>;
export type CreateWeightBody = z.infer<typeof CreateWeightRequest>;
export type BudgetRevisionBody = z.infer<typeof BudgetRevisionRequest>;
export type CreateCommitmentBody = z.infer<typeof CreateCommitmentRequest>;
export type CreateActivityBody = z.infer<typeof CreateActivityRequest>;
//# sourceMappingURL=schemas.d.ts.map