/** Process entrypoint. Configuration failures abort the boot; they are never warnings. */
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
const config = loadConfig();
const app = await buildApp(config);
for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
        app.log.info({ signal }, 'shutting down');
        void app.close().then(() => process.exit(0));
    });
}
try {
    await app.listen({ port: config.port, host: config.host });
}
catch (error) {
    app.log.error({ detail: error instanceof Error ? error.name : 'unknown' }, 'failed to start');
    process.exit(1);
}
//# sourceMappingURL=server.js.map