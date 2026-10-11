/**
 * Daily nutrition.
 *
 * `null` means UNKNOWN and `0` means zero: they are DIFFERENT FACTS and are never
 * coalesced. A day with `calories: 0` is a day the user recorded as zero; a day
 * with `calories: null` is a day nobody recorded.
 */
import type { FastifyInstance } from 'fastify';
export declare function registerNutritionRoutes(app: FastifyInstance): void;
//# sourceMappingURL=routes.d.ts.map