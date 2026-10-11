import { ApiError } from '@hi/contracts';
let byCode = null;
let byId = null;
export async function loadCategories(tx) {
    if (byCode !== null)
        return;
    const { rows } = await tx.query('SELECT id, code FROM categories');
    byCode = new Map(rows.map((r) => [r.code, r.id]));
    byId = new Map(rows.map((r) => [r.id, r.code]));
}
export async function categoryId(tx, code) {
    await loadCategories(tx);
    const id = byCode?.get(code);
    if (id === undefined) {
        throw ApiError.validation('unknown category', [{ path: 'category_code', message: 'not a known category' }]);
    }
    return id;
}
export async function categoryCode(tx, id) {
    await loadCategories(tx);
    const code = byId?.get(id);
    if (code === undefined)
        throw new Error(`unknown category id ${id}`);
    return code;
}
/** Test seam only. */
export function resetCategoryCache() {
    byCode = null;
    byId = null;
}
//# sourceMappingURL=categories.js.map