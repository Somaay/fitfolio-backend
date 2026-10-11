import { type FastifyInstance } from 'fastify';
import type { AppConfig } from './config.js';
import { Database } from './db/pool.js';
import './types.js';
export declare function buildApp(config: AppConfig, database?: Database): Promise<FastifyInstance>;
//# sourceMappingURL=app.d.ts.map