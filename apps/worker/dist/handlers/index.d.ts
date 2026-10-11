import type { Handler } from './types.js';
/**
 * The complete set of job kinds this worker understands. An unknown kind is a
 * PERMANENT failure, not a retry: a worker that cannot recognise a job will not
 * recognise it on the fifth attempt either, and silently retrying hides the
 * deploy-ordering mistake that produced it.
 */
export declare const HANDLERS: Readonly<Record<string, Handler>>;
export declare const KNOWN_JOB_KINDS: string[];
export declare const handlerFor: (kind: string) => Handler | null;
export type { Handler, HandlerContext, HandlerResult } from './types.js';
//# sourceMappingURL=index.d.ts.map