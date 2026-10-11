/**
 * Worker configuration.
 *
 * Every value is read ONCE at startup and validated before the process claims a
 * single job. A misconfigured worker must fail loudly at boot rather than fail
 * quietly halfway through a delivery, so `loadConfig` throws with the full list
 * of problems instead of falling back to defaults for security-relevant values.
 */
export type NotificationAdapterKind = 'log' | 'none' | 'resend';
export interface WorkerConfig {
    readonly nodeEnv: string;
    readonly isProduction: boolean;
    readonly databaseUrl: string;
    readonly logLevel: string;
    readonly pollIntervalMs: number;
    readonly leaseSeconds: number;
    readonly maxAttempts: number;
    readonly batchSize: number;
    readonly sweepIntervalMs: number;
    readonly retryBaseSeconds: number;
    readonly retryMaxSeconds: number;
    readonly notificationAdapter: NotificationAdapterKind;
    readonly notificationLogFile: string | null;
    /** Present if and only if notificationAdapter === 'resend'. */
    readonly resend: {
        readonly apiKey: string;
        readonly from: string;
    } | null;
    readonly healthPort: number | null;
    readonly shutdownGraceMs: number;
}
export declare class ConfigError extends Error {
    readonly problems: readonly string[];
    constructor(problems: readonly string[]);
}
type Env = Record<string, string | undefined>;
export declare function loadConfig(env?: Env): WorkerConfig;
export {};
//# sourceMappingURL=config.d.ts.map