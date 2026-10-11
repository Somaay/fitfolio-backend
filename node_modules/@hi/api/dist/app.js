/**
 * Application wiring.
 *
 * Logging note: pino is configured to redact the cookie, authorization and
 * idempotency headers, and NOTHING logs a request or response body. Weights,
 * amounts, descriptions and tokens must never reach telemetry, so the safe
 * default is to log route shape and outcome only.
 */
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { ApiError } from '@hi/contracts';
import { Database } from './db/pool.js';
import { createOidcVerifier } from './auth/oidc.js';
import { createSupabaseVerifier } from './auth/supabase.js';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import { registerAuth } from './auth/require-auth.js';
import { registerErrorHandling } from './http/errors.js';
import { defineRoute } from './openapi/registry.js';
import { registerAuthRoutes } from './auth/routes.js';
import { registerProfileRoutes } from './profile/routes.js';
import { registerPrivacyRoutes } from './privacy/routes.js';
import { registerPlanRoutes } from './plans/routes.js';
import { registerBudgetRoutes } from './budgets/routes.js';
import { registerCommitmentRoutes } from './commitments/routes.js';
import { registerExpenseRoutes } from './expenses/routes.js';
import { registerWeightRoutes } from './weights/routes.js';
import { registerNutritionRoutes } from './nutrition/routes.js';
import { registerActivityRoutes } from './activities/routes.js';
import { registerReportRoutes } from './reports/routes.js';
import './types.js';
export async function buildApp(config, database) {
    const app = Fastify({
        genReqId: () => randomUUID(),
        bodyLimit: config.bodyLimitBytes,
        trustProxy: config.isProduction,
        logger: {
            level: config.logLevel,
            redact: {
                paths: [
                    'req.headers.cookie', 'req.headers.authorization', 'req.headers["idempotency-key"]',
                    'res.headers["set-cookie"]', 'req.body', 'body',
                ],
                censor: '[redacted]',
            },
            serializers: {
                // Route shape and outcome only. No body, ever.
                req: (request) => ({
                    id: request.id, method: request.method, route: request.routeOptions?.url ?? request.url,
                }),
                res: (reply) => ({ statusCode: reply.statusCode }),
            },
        },
    });
    const db = database ?? new Database(config);
    app.decorate('config', config);
    app.decorate('db', db);
    app.decorate('oidc', config.authMode === 'oidc' ? createOidcVerifier(config.oidc) : null);
    app.decorate('supabase', config.authMode === 'supabase' ? createSupabaseVerifier(config.supabase) : null);
    await app.register(helmet, {
        /**
         * `default-src 'none'` is the right floor for a JSON API, but this process
         * also serves the web app (SERVE_WEB), and a missing directive falls back to
         * default-src. With no connect-src, the browser blocked every fetch to /v1
         * and the app showed "could not reach the server" on a server that was
         * perfectly healthy — invisible to curl, which ignores CSP entirely.
         *
         * Each directive below is the narrowest value that actually works:
         *   connect-src  'self'  — the app talks only to its own origin
         *   script-src   'self'  — no inline script, no CDN
         *   style-src    'self' + unsafe-inline — React sets element styles inline
         *   font-src     'self'  — fonts are self-hosted, so no https: needed
         *   img-src      'self' data: — inline SVG data URIs
         */
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'none'"],
                connectSrc: ["'self'"],
                scriptSrc: ["'self'"],
                styleSrc: ["'self'", "'unsafe-inline'"],
                fontSrc: ["'self'"],
                imgSrc: ["'self'", 'data:'],
                manifestSrc: ["'self'"],
                baseUri: ["'self'"],
                formAction: ["'self'"],
                objectSrc: ["'none'"],
                frameAncestors: ["'none'"],
            },
        },
        crossOriginResourcePolicy: { policy: 'same-site' },
    });
    // Exactly one origin, with credentials. A wildcard origin and credentials are
    // mutually exclusive for good reason: it would let any site read the session.
    await app.register(cors, {
        origin: [config.webOrigin],
        credentials: true,
        methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['content-type', 'if-match', 'idempotency-key', 'authorization'],
        exposedHeaders: ['etag', 'idempotent-replay', 'x-request-id'],
        maxAge: 600,
    });
    await app.register(cookie, { secret: config.sessionSecret, parseOptions: {} });
    await app.register(rateLimit, {
        max: config.rateLimitMax,
        timeWindow: config.rateLimitWindowMs,
        allowList: () => false,
    });
    app.addHook('onSend', async (request, reply) => {
        void reply.header('x-request-id', request.id);
    });
    registerAuth(app);
    registerErrorHandling(app);
    defineRoute(app, {
        method: 'GET', url: '/healthz', operationId: 'healthz', tags: ['ops'], auth: false, quiet: true,
        summary: 'Liveness: the process is up', responses: { 200: 'alive' },
    }, async (_request, reply) => {
        void reply.code(200);
        return { status: 'ok' };
    });
    defineRoute(app, {
        method: 'GET', url: '/readyz', operationId: 'readyz', tags: ['ops'], auth: false, quiet: true,
        summary: 'Readiness: the database is reachable',
        responses: { 200: 'ready', 503: 'the database is not reachable' },
    }, async (request, reply) => {
        try {
            await app.db.ping();
        }
        catch {
            const error = new ApiError('service_unavailable', 'the database is not reachable');
            void reply.code(503);
            return error.toBody(request.id);
        }
        void reply.code(200);
        return { status: 'ready' };
    });
    registerAuthRoutes(app);
    registerProfileRoutes(app);
    registerPrivacyRoutes(app);
    registerPlanRoutes(app);
    registerBudgetRoutes(app);
    registerCommitmentRoutes(app);
    registerExpenseRoutes(app);
    registerWeightRoutes(app);
    registerNutritionRoutes(app);
    registerActivityRoutes(app);
    registerReportRoutes(app);
    // --------------------------------------------------- the web app itself
    // Serving the built SPA from the API keeps everything on ONE origin, which
    // is what lets the session cookie stay SameSite=lax. Splitting the frontend
    // onto its own host would force SameSite=None — a real CSRF downgrade — for
    // no benefit at this size.
    //
    // Off by default: local development uses the Vite dev server, and the tests
    // drive the API directly. Set SERVE_WEB=true (the deployed configuration).
    if (config.serveWeb) {
        const webRoot = resolve(import.meta.dirname, '../../web/dist');
        if (existsSync(join(webRoot, 'index.html'))) {
            // The SPA fallback for unknown client routes lives in the shared
            // not-found handler (http/errors.ts), because Fastify permits only one.
            await app.register(fastifyStatic, { root: webRoot, prefix: '/', index: ['index.html'] });
            app.log.info({ web_root: webRoot }, 'serving the web app from this process');
        }
        else {
            app.log.warn({ web_root: webRoot }, 'SERVE_WEB is set but no build was found; API only');
        }
    }
    app.addHook('onClose', async () => {
        if (!database)
            await db.close();
    });
    return app;
}
//# sourceMappingURL=app.js.map