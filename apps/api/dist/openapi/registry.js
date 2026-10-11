import { requireAuth } from '../auth/require-auth.js';
const registry = [];
export function registeredRoutes() {
    return registry;
}
export function resetRegistry() {
    registry.length = 0;
}
export function defineRoute(app, spec, handler) {
    if (!registry.some((r) => r.method === spec.method && r.url === spec.url))
        registry.push(spec);
    app.route({
        method: spec.method,
        url: spec.url,
        ...(spec.auth ? { preHandler: requireAuth(app) } : {}),
        ...(spec.rateLimit ? { config: { rateLimit: spec.rateLimit } } : {}),
        ...(spec.quiet ? { logLevel: 'silent' } : {}),
        handler: handler,
    });
}
//# sourceMappingURL=registry.js.map