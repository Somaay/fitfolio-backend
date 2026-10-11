/** Stable category codes resolve to small ints once per process. */
import type { Tx } from './pool.js';
import { ApiError, type CategoryCode } from '@hi/contracts';

let byCode: Map<string, number> | null = null;
let byId: Map<number, string> | null = null;

export async function loadCategories(tx: Tx): Promise<void> {
  if (byCode !== null) return;
  const { rows } = await tx.query<{ id: number; code: string }>('SELECT id, code FROM categories');
  byCode = new Map(rows.map((r) => [r.code, r.id]));
  byId = new Map(rows.map((r) => [r.id, r.code]));
}

export async function categoryId(tx: Tx, code: CategoryCode | string): Promise<number> {
  await loadCategories(tx);
  const id = byCode?.get(code);
  if (id === undefined) {
    throw ApiError.validation('unknown category', [{ path: 'category_code', message: 'not a known category' }]);
  }
  return id;
}

export async function categoryCode(tx: Tx, id: number): Promise<CategoryCode> {
  await loadCategories(tx);
  const code = byId?.get(id);
  if (code === undefined) throw new Error(`unknown category id ${id}`);
  return code as CategoryCode;
}

/** Test seam only. */
export function resetCategoryCache(): void {
  byCode = null;
  byId = null;
}
