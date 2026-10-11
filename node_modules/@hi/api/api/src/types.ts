/** Fastify decorations shared by every feature module. */
import 'fastify';
import type { AppConfig } from './config.js';
import type { Database } from './db/pool.js';
import type { OidcVerifier } from './auth/oidc.js';

export interface AuthenticatedUser {
  readonly userId: string;
  readonly issuer: string;
  readonly subject: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    config: AppConfig;
    db: Database;
    oidc: OidcVerifier | null;
  }
  interface FastifyRequest {
    auth: AuthenticatedUser | null;
  }
}
