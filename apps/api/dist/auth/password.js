/**
 * Password hashing and verification.
 *
 * Uses Node's built-in scrypt — a vetted, memory-hard KDF from core, so there is
 * no homemade cryptography here and no native dependency to keep patched.
 * Parameters follow the OWASP Password Storage Cheat Sheet's scrypt guidance
 * (N = 2^16, r = 8, p = 1 → roughly 64 MiB per hash). Memory hardness is what
 * makes offline cracking expensive; the cost is paid per login attempt, which is
 * why login is also rate limited and the credential locks out.
 *
 * The encoded form records the algorithm and its parameters:
 *     scrypt$N$r$p$<salt base64url>$<hash base64url>
 * so parameters can be raised later and old hashes upgraded transparently on the
 * next successful login, rather than being guessed at.
 */
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
/**
 * promisify() picks scrypt's 3-argument overload and drops the options one, so
 * the cost parameters would be silently lost. Wrap it explicitly instead.
 */
function scryptAsync(password, salt, keylen, options) {
    return new Promise((resolve, reject) => {
        scrypt(password, salt, keylen, options, (err, derived) => {
            if (err)
                reject(err);
            else
                resolve(derived);
        });
    });
}
const ALGORITHM = 'scrypt';
const N = 65_536; // CPU/memory cost
const R = 8; // block size
const P = 1; // parallelisation
const KEY_LEN = 64;
const SALT_LEN = 16;
/** scrypt needs roughly 128 * N * r bytes; allow headroom or Node throws. */
const MAX_MEM = 192 * 1024 * 1024;
export const PASSWORD_MIN_LENGTH = 12;
/** Bounded so a multi-megabyte body cannot turn one login into a CPU attack. */
export const PASSWORD_MAX_LENGTH = 256;
/**
 * Weak roots. A password is rejected when, after stripping case, spaces and
 * trailing digits/punctuation, what remains is one of these — so "password1234"
 * and "Fitfolio!!2026" are caught, not just the bare words. Padding a guessable
 * word to the length minimum is the commonest way to satisfy a length rule
 * without gaining any real entropy.
 */
const WEAK_ROOTS = new Set([
    'password', 'passwd', 'pass', 'qwerty', 'qwertyuiop', 'asdfgh', 'zxcvbn',
    'letmein', 'welcome', 'admin', 'administrator', 'root', 'login', 'secret',
    'iloveyou', 'monkey', 'dragon', 'football', 'baseball', 'sunshine', 'princess',
    'trustno', 'changeme', 'default', 'fitfolio', 'health', 'fitness', 'money',
    'abcdef', 'abcdefg', 'abcdefgh', 'test', 'demo', 'guest', 'user',
]);
/** Strip case, whitespace, and leading/trailing digits or punctuation. */
function root(password) {
    return password
        .toLowerCase()
        .replace(/\s+/g, '')
        .replace(/^[^a-z]+/, '')
        .replace(/[^a-z]+$/, '');
}
/**
 * Policy: length first, then guessability. Deliberately NO character-class
 * rules — they push people toward "Passw0rd!" without adding real entropy, and
 * NIST SP 800-63B advises against composition requirements in favour of length
 * and a blocklist.
 */
export function checkPasswordPolicy(password) {
    if (password.length < PASSWORD_MIN_LENGTH) {
        return { message: `use at least ${PASSWORD_MIN_LENGTH} characters` };
    }
    if (password.length > PASSWORD_MAX_LENGTH) {
        return { message: `use at most ${PASSWORD_MAX_LENGTH} characters` };
    }
    const stripped = root(password);
    if (WEAK_ROOTS.has(stripped)) {
        return { message: 'that is too close to a commonly guessed password; try a few unrelated words' };
    }
    if (/^(.)\1+$/.test(password)) {
        return { message: 'a single repeated character is too easy to guess' };
    }
    // Runs like 123456789012 or abcdefghijkl.
    if (/^(?:0123456789|1234567890|abcdefghij|qwertyuiop)/.test(password.toLowerCase().replace(/\s+/g, ''))) {
        return { message: 'a keyboard or counting run is too easy to guess; try a few unrelated words' };
    }
    if (new Set(password).size < 5) {
        return { message: 'use a few more different characters' };
    }
    return null;
}
export async function hashPassword(password) {
    const salt = randomBytes(SALT_LEN);
    const derived = await scryptAsync(password.normalize('NFKC'), salt, KEY_LEN, { N, r: R, p: P, maxmem: MAX_MEM });
    return [
        ALGORITHM, N, R, P,
        salt.toString('base64url'),
        derived.toString('base64url'),
    ].join('$');
}
/**
 * Constant-time verification. Returns false for any malformed stored value
 * rather than throwing, so a corrupt row cannot be distinguished from a wrong
 * password by timing or by error text.
 */
export async function verifyPassword(password, stored) {
    const parts = stored.split('$');
    if (parts.length !== 6)
        return false;
    const [algorithm, nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts;
    if (algorithm !== ALGORITHM)
        return false;
    const n = Number(nRaw), r = Number(rRaw), p = Number(pRaw);
    if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p))
        return false;
    if (n <= 0 || r <= 0 || p <= 0 || n > 1_048_576)
        return false;
    let salt, expected;
    try {
        salt = Buffer.from(saltRaw, 'base64url');
        expected = Buffer.from(hashRaw, 'base64url');
    }
    catch {
        return false;
    }
    if (salt.length === 0 || expected.length === 0)
        return false;
    let actual;
    try {
        actual = await scryptAsync(password.normalize('NFKC'), salt, expected.length, { N: n, r, p, maxmem: MAX_MEM });
    }
    catch {
        return false;
    }
    return actual.length === expected.length && timingSafeEqual(actual, expected);
}
/** True when a stored hash was made with weaker parameters than we now use. */
export function needsRehash(stored) {
    const [algorithm, n, r, p] = stored.split('$');
    return algorithm !== ALGORITHM || Number(n) < N || Number(r) < R || Number(p) < P;
}
/**
 * A hash of a throwaway value, used to spend comparable time when no account
 * exists for the submitted address. Without it, "unknown email" returns fast and
 * "known email, wrong password" returns slowly, which enumerates accounts.
 */
let decoyHash = null;
export async function burnEquivalentTime(password) {
    decoyHash ??= await hashPassword(randomBytes(32).toString('base64url'));
    await verifyPassword(password, decoyHash);
}
// ------------------------------------------------------------ reset tokens
/**
 * A reset token is 256 bits of randomness, so it cannot be guessed and there is
 * nothing to brute force. That is why it is stored as a plain SHA-256 rather
 * than a slow KDF: the slow hash exists to defend LOW-entropy secrets, and
 * using one here would only make every reset request expensive.
 *
 * The raw token exists in exactly two places: the link sent to the user, and
 * the request that redeems it. The database holds only the digest.
 */
export function newResetToken() {
    const token = randomBytes(32).toString('base64url');
    return { token, hash: hashResetToken(token) };
}
export function hashResetToken(token) {
    return createHash('sha256').update(token, 'utf8').digest('hex');
}
//# sourceMappingURL=password.js.map