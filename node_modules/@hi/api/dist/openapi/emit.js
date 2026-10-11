/**
 * `npm run -w @hi/api openapi`
 *
 * Boots the real application so the document is generated from the routes that
 * are actually registered, then writes apps/api/openapi.json. No database
 * connection is opened: the pool is lazy and nothing here issues a query.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { buildOpenApiDocument } from './spec.js';
const config = loadConfig({
    ...process.env,
    NODE_ENV: 'development',
    AUTH_MODE: process.env.AUTH_MODE ?? 'dev',
    DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://hi_api@127.0.0.1:55433/health_investment',
    SESSION_SECRET: process.env.SESSION_SECRET ?? 'openapi-generation-placeholder-secret-value',
    LOG_LEVEL: 'silent',
});
const app = await buildApp(config);
await app.ready();
const document = buildOpenApiDocument();
const target = resolve(import.meta.dirname, '../../openapi.json');
writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
const pathCount = Object.keys(document.paths).length;
const operationCount = Object.values(document.paths)
    .reduce((sum, methods) => sum + Object.keys(methods).length, 0);
await app.close();
process.stdout.write(`[openapi] ${operationCount} operations across ${pathCount} paths -> ${target}\n`);
//# sourceMappingURL=emit.js.map