import { accountErasure } from './account-erasure.js';
import { passwordReset } from './password-reset.js';
import { accountExport } from './account-export.js';
import { weeklyReminder } from './weekly-reminder.js';
/**
 * The complete set of job kinds this worker understands. An unknown kind is a
 * PERMANENT failure, not a retry: a worker that cannot recognise a job will not
 * recognise it on the fifth attempt either, and silently retrying hides the
 * deploy-ordering mistake that produced it.
 */
export const HANDLERS = Object.freeze({
    weekly_reminder: weeklyReminder,
    account_export: accountExport,
    account_erasure: accountErasure,
    password_reset: passwordReset,
});
export const KNOWN_JOB_KINDS = Object.keys(HANDLERS);
export const handlerFor = (kind) => Object.prototype.hasOwnProperty.call(HANDLERS, kind) ? HANDLERS[kind] : null;
//# sourceMappingURL=index.js.map