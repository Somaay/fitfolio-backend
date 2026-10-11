/** Stable category codes resolve to small ints once per process. */
import type { Tx } from './pool.js';
import { type CategoryCode } from '@hi/contracts';
export declare function loadCategories(tx: Tx): Promise<void>;
export declare function categoryId(tx: Tx, code: CategoryCode | string): Promise<number>;
export declare function categoryCode(tx: Tx, id: number): Promise<CategoryCode>;
/** Test seam only. */
export declare function resetCategoryCache(): void;
//# sourceMappingURL=categories.d.ts.map