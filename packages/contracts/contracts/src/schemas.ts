/**
 * Shared request/response schemas. The API validates with these and the web app
 * imports the inferred types, so a field cannot be renamed on one side only.
 */
import { z } from 'zod';
import { SUPPORTED_CURRENCIES } from './money.js';
import { isValidTimeZone } from './plan-calendar.js';

/** Money crosses the wire as a decimal integer string in MINOR units. */
export const MinorAmount = z.string().regex(/^(0|[1-9][0-9]{0,15})$/, 'must be a non-negative integer string of minor units');
export const SignedMinorAmount = z.string().regex(/^-?(0|[1-9][0-9]{0,15})$/);
export const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');
export const WeightKgSchema = z.string().regex(/^\d{1,3}(\.\d{1,3})?$/, 'kg with at most 3 decimals');
export const TimeZoneSchema = z.string().min(1).max(64).refine(isValidTimeZone, 'must be a valid IANA time zone');
export const CurrencySchema = z.enum(SUPPORTED_CURRENCIES as [string, ...string[]]);
export const CategoryCodeSchema = z.enum(['gym', 'trainer', 'groceries', 'prepared_meals', 'supplements', 'other']);
export const BudgetScopeSchema = z.enum(['total', 'incremental']);
export const Uuid = z.string().uuid();

export type CategoryCode = z.infer<typeof CategoryCodeSchema>;

// ---------------------------------------------------------------- profile
export const UpdateProfileRequest = z.object({
  display_name: z.string().min(1).max(120).nullish(),
  timezone: TimeZoneSchema.optional(),
  weight_unit: z.enum(['kg', 'lb']).optional(),
  notification_opt_in: z.boolean().optional(),
});

export const ConsentRequest = z.object({
  purpose: z.enum(['essential_processing', 'weekly_reminders', 'product_updates']),
  policy_version: z.string().min(1).max(32),
  action: z.enum(['granted', 'revoked']),
});

// ------------------------------------------------------------------ plans
export const CreatePlanRequest = z.object({
  name: z.string().min(1).max(120),
  start_date: IsoDateSchema,
  timezone: TimeZoneSchema,
  currency_code: CurrencySchema,
  budget_scope: BudgetScopeSchema,
  baseline_weight_kg: WeightKgSchema,
  target_weight_kg: WeightKgSchema,
  daily_calorie_target: z.number().int().min(0).max(20000).nullish(),
  daily_protein_target_g: z.string().regex(/^\d{1,4}(\.\d{1,2})?$/).nullish(),
  budget: z.object({
    total_minor: MinorAmount,
    reason: z.string().min(1).max(280).default('Initial budget'),
    lines: z.array(z.object({
      category_code: CategoryCodeSchema,
      allocated_minor: MinorAmount,
    })).max(6).default([]),
  }),
});

export const UpdatePlanRequest = z.object({
  name: z.string().min(1).max(120).optional(),
  start_date: IsoDateSchema.optional(),
  timezone: TimeZoneSchema.optional(),
  currency_code: CurrencySchema.optional(),
  budget_scope: BudgetScopeSchema.optional(),
  baseline_weight_kg: WeightKgSchema.optional(),
  target_weight_kg: WeightKgSchema.optional(),
  daily_calorie_target: z.number().int().min(0).max(20000).nullish(),
  daily_protein_target_g: z.string().regex(/^\d{1,4}(\.\d{1,2})?$/).nullish(),
});

export const BudgetRevisionRequest = z.object({
  total_minor: MinorAmount,
  effective_on: IsoDateSchema.optional(),
  reason: z.string().min(1).max(280),
  lines: z.array(z.object({
    category_code: CategoryCodeSchema,
    allocated_minor: MinorAmount,
  })).max(6),
});

// ------------------------------------------------------------- commitments
export const CreateCommitmentRequest = z.object({
  category_code: CategoryCodeSchema,
  label: z.string().min(1).max(120),
  due_on: IsoDateSchema,
  expected_minor: MinorAmount,
  attributable_minor: MinorAmount,
  expected_sessions: z.number().int().positive().max(1000).nullish(),
});

export const UpdateCommitmentRequest = z.object({
  label: z.string().min(1).max(120).optional(),
  due_on: IsoDateSchema.optional(),
  expected_minor: MinorAmount.optional(),
  attributable_minor: MinorAmount.optional(),
  expected_sessions: z.number().int().positive().max(1000).nullish(),
  status: z.enum(['pending', 'completed', 'cancelled']).optional(),
});

/** Idempotent expansion of a recurring estimate into dated commitments. */
export const GenerateCommitmentsRequest = z.object({
  category_code: CategoryCodeSchema,
  label: z.string().min(1).max(120),
  amount_minor: MinorAmount,
  attributable_minor: MinorAmount,
  cadence: z.enum(['monthly', 'weekly']),
  first_due_on: IsoDateSchema,
  occurrences: z.number().int().min(1).max(52),
  expected_sessions: z.number().int().positive().max(1000).nullish(),
});

// ---------------------------------------------------------------- expenses
export const CreateExpenseRequest = z.object({
  category_code: CategoryCodeSchema,
  paid_on: IsoDateSchema,
  amount_minor: MinorAmount,
  attributable_minor: MinorAmount,
  description: z.string().max(280).nullish(),
  commitment_id: Uuid.nullish(),
});

export const CreateRefundRequest = z.object({
  refunded_on: IsoDateSchema,
  amount_minor: MinorAmount,
  attributable_minor: MinorAmount,
  description: z.string().max(280).nullish(),
});

/** Atomic void-and-replace. Never model a data-entry fix as a refund. */
export const CorrectExpenseRequest = z.object({
  reason: z.string().min(1).max(280),
  replacement: CreateExpenseRequest,
});

// ----------------------------------------------------------------- weights
export const CreateWeightRequest = z.object({
  measured_at: z.string().datetime({ offset: true }),
  weight_kg: WeightKgSchema,
});
export const UpdateWeightRequest = z.object({
  measured_at: z.string().datetime({ offset: true }).optional(),
  weight_kg: WeightKgSchema.optional(),
});

// --------------------------------------------------------------- nutrition
/** A missing field means UNKNOWN; an explicit 0 means zero. Hence `.nullable()`. */
export const PutNutritionRequest = z.object({
  calories: z.number().int().min(0).max(20000).nullable(),
  protein_g: z.string().regex(/^\d{1,4}(\.\d{1,2})?$/).nullable(),
}).refine((v) => v.calories !== null || v.protein_g !== null, {
  message: 'record at least one of calories or protein',
});

// ---------------------------------------------------------------- activity
export const CreateActivityRequest = z.object({
  occurred_at: z.string().datetime({ offset: true }),
  kind: z.enum(['gym', 'trainer', 'home_workout', 'other']),
  status: z.enum(['completed', 'missed']),
  duration_minutes: z.number().int().positive().max(1440).nullish(),
  commitment_id: Uuid.nullish(),
});
export const UpdateActivityRequest = CreateActivityRequest.partial();

// ------------------------------------------------------------------ common
export const AsOfQuery = z.object({ as_of: IsoDateSchema.optional() });
export const PaginationQuery = z.object({
  cursor: z.string().max(256).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  from: IsoDateSchema.optional(),
  to: IsoDateSchema.optional(),
});

export type CreatePlanBody = z.infer<typeof CreatePlanRequest>;
export type CreateExpenseBody = z.infer<typeof CreateExpenseRequest>;
export type CreateWeightBody = z.infer<typeof CreateWeightRequest>;
export type BudgetRevisionBody = z.infer<typeof BudgetRevisionRequest>;
export type CreateCommitmentBody = z.infer<typeof CreateCommitmentRequest>;
export type CreateActivityBody = z.infer<typeof CreateActivityRequest>;
