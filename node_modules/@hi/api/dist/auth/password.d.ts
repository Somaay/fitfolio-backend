export declare const PASSWORD_MIN_LENGTH = 12;
/** Bounded so a multi-megabyte body cannot turn one login into a CPU attack. */
export declare const PASSWORD_MAX_LENGTH = 256;
export interface PasswordProblem {
    readonly message: string;
}
/**
 * Policy: length first, then guessability. Deliberately NO character-class
 * rules — they push people toward "Passw0rd!" without adding real entropy, and
 * NIST SP 800-63B advises against composition requirements in favour of length
 * and a blocklist.
 */
export declare function checkPasswordPolicy(password: string): PasswordProblem | null;
export declare function hashPassword(password: string): Promise<string>;
/**
 * Constant-time verification. Returns false for any malformed stored value
 * rather than throwing, so a corrupt row cannot be distinguished from a wrong
 * password by timing or by error text.
 */
export declare function verifyPassword(password: string, stored: string): Promise<boolean>;
/** True when a stored hash was made with weaker parameters than we now use. */
export declare function needsRehash(stored: string): boolean;
export declare function burnEquivalentTime(password: string): Promise<void>;
/**
 * A reset token is 256 bits of randomness, so it cannot be guessed and there is
 * nothing to brute force. That is why it is stored as a plain SHA-256 rather
 * than a slow KDF: the slow hash exists to defend LOW-entropy secrets, and
 * using one here would only make every reset request expensive.
 *
 * The raw token exists in exactly two places: the link sent to the user, and
 * the request that redeems it. The database holds only the digest.
 */
export declare function newResetToken(): {
    token: string;
    hash: string;
};
export declare function hashResetToken(token: string): string;
//# sourceMappingURL=password.d.ts.map