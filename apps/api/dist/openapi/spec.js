/**
 * OpenAPI 3.1 document, built from the SAME registry the server registers routes
 * with. There is no separate hand-written list to drift out of date: a route that
 * is not registered cannot appear here, and one that is cannot be omitted.
 */
import { ERROR_CODES } from '@hi/contracts';
import { registeredRoutes } from './registry.js';
import { zodToJsonSchema } from './zod-schema.js';
const ERROR_SCHEMA = {
    type: 'object',
    required: ['code', 'message', 'fields', 'request_id'],
    properties: {
        code: { type: 'string', enum: Object.keys(ERROR_CODES) },
        message: { type: 'string' },
        fields: {
            type: 'array',
            items: {
                type: 'object',
                required: ['path', 'message'],
                properties: { path: { type: 'string' }, message: { type: 'string' } },
            },
        },
        request_id: { type: 'string' },
    },
};
/** `/v1/plans/:planId` -> `/v1/plans/{planId}` plus its path parameters. */
function toOpenApiPath(url) {
    const parameters = [];
    const path = url.replace(/:([A-Za-z0-9_]+)/g, (_match, name) => {
        parameters.push({
            name, in: 'path', required: true,
            schema: name === 'date' ? { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } : { type: 'string', format: 'uuid' },
        });
        return `{${name}}`;
    });
    return { path, parameters };
}
function queryParameters(schema) {
    if (!schema)
        return [];
    const json = zodToJsonSchema(schema);
    const properties = (json.properties ?? {});
    const required = new Set((json.required ?? []));
    return Object.entries(properties).map(([name, propertySchema]) => ({
        name, in: 'query', required: required.has(name), schema: propertySchema,
    }));
}
function headerParameters(spec) {
    const headers = [];
    if (spec.idempotent) {
        headers.push({
            name: 'Idempotency-Key', in: 'header', required: false,
            description: 'Replays the stored response for the same key and body; a different body returns 409 idempotency_key_conflict.',
            schema: { type: 'string', maxLength: 128 },
        });
    }
    if (spec.ifMatch) {
        headers.push({
            name: 'If-Match', in: 'header', required: true,
            description: 'The version from your last read, e.g. "3". A mismatch returns 412 stale_version.',
            schema: { type: 'string' },
        });
    }
    return headers;
}
function responsesFor(spec) {
    const responses = {};
    for (const [status, description] of Object.entries(spec.responses)) {
        const code = Number(status);
        responses[status] = code >= 400
            ? { description, content: { 'application/json': { schema: ERROR_SCHEMA } } }
            : code === 204
                ? { description }
                : {
                    description,
                    content: { 'application/json': { schema: { type: 'object' } } },
                    ...(spec.ifMatch || code === 200
                        ? { headers: { ETag: { description: 'The resource version, for If-Match', schema: { type: 'string' } } } }
                        : {}),
                };
    }
    // Every authenticated route can answer these.
    if (spec.auth) {
        responses['401'] ??= { description: 'no valid session', content: { 'application/json': { schema: ERROR_SCHEMA } } };
        responses['403'] ??= { description: 'the account is deactivated', content: { 'application/json': { schema: ERROR_SCHEMA } } };
        responses['404'] ??= { description: 'absent or not owned', content: { 'application/json': { schema: ERROR_SCHEMA } } };
    }
    responses['429'] ??= { description: 'rate limited', content: { 'application/json': { schema: ERROR_SCHEMA } } };
    responses['500'] ??= { description: 'internal error', content: { 'application/json': { schema: ERROR_SCHEMA } } };
    return responses;
}
export function buildOpenApiDocument(version = '0.1.0') {
    const paths = {};
    for (const spec of registeredRoutes()) {
        const { path, parameters } = toOpenApiPath(spec.url);
        paths[path] ??= {};
        const operation = {
            operationId: spec.operationId,
            summary: spec.summary,
            ...(spec.description ? { description: spec.description } : {}),
            tags: [...spec.tags],
            parameters: [...parameters, ...queryParameters(spec.query), ...headerParameters(spec)],
            responses: responsesFor(spec),
            ...(spec.auth ? { security: [{ sessionCookie: [] }] } : { security: [] }),
        };
        if (spec.body) {
            operation.requestBody = {
                required: true,
                content: { 'application/json': { schema: zodToJsonSchema(spec.body) } },
            };
        }
        paths[path][spec.method.toLowerCase()] = operation;
    }
    return {
        openapi: '3.1.0',
        info: {
            title: 'Health investment API',
            version,
            description: 'Money is a decimal integer STRING in minor units; weight is kg as a string with up to three decimals; business dates are YYYY-MM-DD in the plan\'s frozen time zone. Ownership is derived from the verified session only, and an unowned id returns 404, never 403.',
        },
        servers: [{ url: '/' }],
        tags: [
            { name: 'auth' }, { name: 'profile' }, { name: 'privacy' }, { name: 'plans' },
            { name: 'budgets' }, { name: 'commitments' }, { name: 'expenses' }, { name: 'weights' },
            { name: 'nutrition' }, { name: 'activities' }, { name: 'reports' }, { name: 'ops' },
        ],
        components: {
            securitySchemes: {
                sessionCookie: { type: 'apiKey', in: 'cookie', name: 'hi_session' },
            },
            schemas: { Error: ERROR_SCHEMA },
        },
        paths,
    };
}
//# sourceMappingURL=spec.js.map