import { userRef } from './logger.js';
import { assertSafeContent, } from './notifications.js';
const ENDPOINT = 'https://api.resend.com/emails';
/**
 * A 4xx will fail the same way on the fifth attempt (bad key, unverified
 * domain, malformed address), so it is permanent. A 5xx, a timeout or a
 * transport error is worth retrying.
 */
export class ResendDeliveryError extends Error {
    retryable;
    code;
    constructor(code, retryable, message) {
        super(message);
        this.name = 'ResendDeliveryError';
        this.code = code;
        this.retryable = retryable;
    }
}
/**
 * Templates live here rather than in the handler so the handler stays about
 * *whether* to send and this stays about *what it looks like*.
 */
function render(notification) {
    const minutes = Number(notification.vars['expires_in_minutes'] ?? 30);
    const link = notification.link ?? '';
    if (notification.template === 'password_reset') {
        return {
            subject: 'Reset your Fitfolio password',
            text: [
                'Someone asked to reset the password for this Fitfolio account.',
                '',
                `Open this link to choose a new one. It works once and expires in ${minutes} minutes:`,
                link,
                '',
                'Setting a new password signs you out on every device.',
                '',
                'If this was not you, you can ignore this email — your password has not changed.',
                '',
                'Fitfolio — your health, your best investment.',
            ].join('\n'),
            html: emailShell('Reset your password', `<p>Someone asked to reset the password for this Fitfolio account.</p>
         <p>Choose a new one using the button below. The link works once and expires in
            <strong>${minutes} minutes</strong>.</p>
         <p style="margin:28px 0"><a class="btn" href="${escapeAttribute(link)}">Set a new password</a></p>
         <p class="muted">Setting a new password signs you out on every device.</p>
         <p class="muted">If this was not you, you can ignore this email — your password has not changed.</p>`),
        };
    }
    if (notification.template === 'weekly_reminder') {
        const week = notification.vars['week'];
        return {
            subject: 'Your Fitfolio check-in',
            text: [
                `It is time for your week ${String(week ?? '')} check-in.`,
                '',
                'Record your weigh-in and anything you have spent. It takes a minute.',
                '',
                'Fitfolio — your health, your best investment.',
            ].join('\n'),
            html: emailShell('Your check-in', `<p>It is time for your week <strong>${escapeHtml(String(week ?? ''))}</strong> check-in.</p>
         <p>Record your weigh-in and anything you have spent. It takes a minute.</p>`),
        };
    }
    // An unknown template must not silently send a blank email.
    throw new ResendDeliveryError('unknown_template', false, `no email template for "${notification.template}"`);
}
/** Brand-consistent shell. Inline styles: email clients strip <style> blocks. */
function emailShell(heading, body) {
    return `<!doctype html><html><body style="margin:0;background:#faf1df;padding:28px 16px;
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#241230">
    <div style="max-width:520px;margin:0 auto;background:#fffdf8;border:2px solid #241230;
      border-radius:18px;box-shadow:4px 4px 0 #241230;padding:28px">
      <div style="font-size:19px;font-weight:800;letter-spacing:-.02em;margin-bottom:6px">Fitfolio</div>
      <h1 style="font-size:24px;line-height:1.15;letter-spacing:-.03em;margin:0 0 16px">${escapeHtml(heading)}</h1>
      <div style="font-size:15px;line-height:1.6">${body}</div>
      <hr style="border:0;border-top:2px dashed #8a7a93;margin:26px 0">
      <div style="font-size:12px;color:#5b4666">Your health. Your best investment.</div>
    </div>
  </body></html>`
        .replace(/class="btn"/g, 'style="display:inline-block;background:#1b3fcb;color:#fff;text-decoration:none;'
        + 'font-weight:700;padding:13px 20px;border:2px solid #241230;border-radius:8px"')
        .replace(/class="muted"/g, 'style="color:#5b4666;font-size:13px"');
}
const escapeHtml = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttribute = (value) => escapeHtml(value).replace(/"/g, '&quot;');
export class ResendNotificationAdapter {
    kind = 'resend';
    isRealDelivery = true;
    #apiKey;
    #from;
    #lookup;
    #logger;
    #fetch;
    #timeoutMs;
    constructor(options) {
        this.#apiKey = options.apiKey;
        this.#from = options.from;
        this.#lookup = options.lookupRecipient;
        this.#logger = options.logger;
        this.#fetch = options.fetchImpl ?? ((url, init) => fetch(url, init));
        this.#timeoutMs = options.timeoutMs ?? 10_000;
    }
    async send(notification) {
        assertSafeContent(notification);
        const to = await this.#lookup(notification.userId);
        if (to === null || to === '') {
            throw new ResendDeliveryError('no_recipient', false, 'no email address on file for this account');
        }
        const email = render(notification);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
        let response;
        try {
            response = await this.#fetch(ENDPOINT, {
                method: 'POST',
                headers: {
                    authorization: `Bearer ${this.#apiKey}`,
                    'content-type': 'application/json',
                    // Resend de-duplicates on this, so a retry after an ambiguous failure
                    // does not send the message twice.
                    'Idempotency-Key': notification.dedupeKey,
                },
                body: JSON.stringify({
                    from: this.#from,
                    to: [to],
                    subject: email.subject,
                    text: email.text,
                    html: email.html,
                }),
                signal: controller.signal,
            });
        }
        catch (error) {
            const aborted = error.name === 'AbortError';
            throw new ResendDeliveryError(aborted ? 'timeout' : 'transport_error', true, aborted ? 'the delivery request timed out' : 'the delivery request could not be made');
        }
        finally {
            clearTimeout(timer);
        }
        if (!response.ok) {
            // The body may echo the address; read only the status and Resend's short
            // error name, never the whole payload into a log.
            const retryable = response.status >= 500 || response.status === 429;
            let name = 'http_error';
            try {
                const parsed = (await response.json());
                if (typeof parsed.name === 'string')
                    name = parsed.name;
            }
            catch { /* a non-JSON error body tells us nothing useful */ }
            throw new ResendDeliveryError(`resend_${response.status}`, retryable, `delivery rejected (${response.status} ${name})`);
        }
        // Recipient is logged as a pseudonymous reference, and the link never is.
        this.#logger.info({
            delivery: 'sent',
            adapter: this.kind,
            template: notification.template,
            recipient: userRef(notification.userId),
            dedupe_key: notification.dedupeKey,
        }, 'notification delivered');
    }
}
//# sourceMappingURL=resend.js.map