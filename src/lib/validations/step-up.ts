/**
 * Request schemas for the step-up elevation surface. Single-sourced here so the
 * runtime `safeParse` and the OpenAPI registry describe the identical wire
 * contract.
 */
import { z } from "zod/v4";
import { webauthnCredentialSchema } from "@/lib/validations/mfa";

/**
 * Re-prove a factor to mint an elevation. Four accepted proofs, discriminated on
 * `method`, and the choice is an AUTHORISATION input rather than a preference:
 *
 *   - `password` — the account password. Reaches exactly what a plain cookie
 *     session reaches. Unavailable on an account provisioned through OIDC SSO
 *     that never set one.
 *   - `totp` — a current code from the enrolled authenticator.
 *   - `webauthn` — an assertion from a registered second-factor security key,
 *     begun at `/api/auth/step-up/options` with `method: "webauthn"`.
 *   - `passkey` — an assertion from a primary passkey, begun at the same
 *     endpoint with `method: "passkey"`.
 *
 * Only the last three satisfy the fresh-factor routes, mirroring the web, where
 * a password login never stamps a session second-factor-verified.
 *
 * The password is length-bounded so a body cap is not the only thing standing
 * between a caller and an unbounded Argon2id verify.
 */
export const stepUpMintSchema = z
  .discriminatedUnion("method", [
    z.object({
      method: z.literal("password"),
      password: z.string().min(1).max(512),
    }),
    z.object({
      method: z.literal("totp"),
      code: z
        .string()
        .trim()
        .regex(/^\d{6}$/, "Enter the 6-digit code from your authenticator app"),
    }),
    z.object({
      method: z.literal("webauthn"),
      challengeId: z.string().min(1),
      credential: webauthnCredentialSchema,
    }),
    z.object({
      method: z.literal("passkey"),
      challengeId: z.string().min(1),
      credential: webauthnCredentialSchema,
    }),
  ])
  .meta({
    id: "StepUpMintRequest",
    description:
      "Re-prove a factor to mint a single-use, token-bound step-up elevation. `password` reaches the same routes a plain cookie session reaches; `totp`, `webauthn`, and `passkey` additionally satisfy the fresh-factor routes (disable, recovery-code rotation, security-key removal), matching exactly the ceremonies for which the web stamps a session second-factor-verified.",
  });

/** Which assertion ceremony to begin at `POST /api/auth/step-up/options`. */
export const stepUpOptionsSchema = z
  .object({
    method: z
      .enum(["passkey", "webauthn"])
      .describe(
        "`passkey` begins an assertion against the account's primary passkeys; `webauthn` against its registered second-factor security keys.",
      ),
  })
  .meta({ id: "StepUpOptionsRequest" });
