/**
 * Which re-proved factors satisfy a fresh-factor gate.
 *
 * On its own, with nothing imported, because it is an authorisation input
 * the structural guards read directly: the definition is pinned by
 * `step-up-elevation-guard.test.ts`, and reaching it through `step-up.ts`
 * meant loading the database client and the generated Prisma client inside
 * a test body.
 */
/**
 * Which factor was re-proved. This is an AUTHORISATION INPUT — see
 * `FRESH_FACTOR_METHODS` and the file header.
 *
 *   password — the account password. Reaches what a plain cookie session
 *              reaches, and no further.
 *   totp     — a current code from the enrolled authenticator.
 *   webauthn — an assertion from a registered second-factor security key.
 *   passkey  — an assertion from a primary passkey. At parity with
 *              `/api/auth/passkey/login-verify`, which stamps `mfaVerifiedAt`
 *              on the web for the very same ceremony.
 */
export type StepUpMethod = "password" | "totp" | "webauthn" | "passkey";

/**
 * The methods that satisfy a fresh-factor gate — exactly the set for which the
 * web writes `mfaVerifiedAt`. `password` is deliberately absent: a password
 * login has never satisfied step-up on the web and must not start here.
 *
 * A recovery code is also absent, and that IS a narrowing relative to the web,
 * where `/api/auth/mfa/verify` accepts one and does stamp the session. The
 * consequence is that an account which has lost its authenticator cannot
 * disable its second factor from the app — only from the web. That asymmetry is
 * deliberate and flagged rather than quietly closed, because admitting a
 * recovery code here means spending one break-glass credential to authorise
 * spending another.
 */
export const FRESH_FACTOR_METHODS: ReadonlySet<StepUpMethod> = new Set([
  "totp",
  "webauthn",
  "passkey",
]);

export function isFreshFactorMethod(method: StepUpMethod): boolean {
  return FRESH_FACTOR_METHODS.has(method);
}
