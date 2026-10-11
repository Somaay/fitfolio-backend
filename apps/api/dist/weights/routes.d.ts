/**
 * Weight measurements.
 *
 * `local_date` is derived on the SERVER from `measured_at` and the plan's FROZEN
 * zone (D-03). Deriving it from the browser's current zone would silently move
 * history between reporting weeks whenever the user travels or edits a profile.
 * Several readings per day are expected and supported: the weekly trend averages
 * each day first, then takes the median of those daily means.
 */
import type { FastifyInstance } from 'fastify';
export declare function registerWeightRoutes(app: FastifyInstance): void;
//# sourceMappingURL=routes.d.ts.map