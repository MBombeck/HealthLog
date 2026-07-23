/**
 * Request schemas for the second-factor (MFA) surface. Single-sourced here so
 * the runtime `safeParse` and the OpenAPI registry (`src/lib/openapi/routes/
 * auth.ts`) describe the identical wire contract.
 */
import { z } from "zod/v4";

/** A 6-digit TOTP code. */
export const totpCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, "Enter the 6-digit code from your authenticator app");

export const totpConfirmSchema = z.object({
  code: totpCodeSchema,
});

/** Disable MFA: prove possession of a current factor (TOTP or recovery code). */
export const mfaDisableSchema = z
  .object({
    code: z.string().trim().min(6).max(32),
    method: z.enum(["totp", "recovery"]).default("totp"),
  })
  .meta({
    id: "MfaDisableRequest",
    description:
      "Disable the second factor. Requires fresh step-up plus a current TOTP or recovery code.",
  });

/** Login second-factor completion: ticket + a TOTP or recovery code. */
export const mfaVerifySchema = z
  .object({
    mfaTicket: z
      .string()
      .min(1)
      .describe("The opaque single-use ticket from the login response."),
    method: z.enum(["totp", "recovery"]).default("totp"),
    code: z.string().trim().min(6).max(32),
    rememberDevice: z
      .boolean()
      .optional()
      .describe(
        "Opt in to trusting this device for 30 days — subsequent logins skip the second factor (the password is still required).",
      ),
  })
  .meta({
    id: "MfaVerifyRequest",
    description:
      "Complete a second-factor login challenge and receive the same token bundle the password path issues.",
  });

// ── WebAuthn security key (second factor) ────────────────────────────

/**
 * A SimpleWebAuthn-style ceremony response. Kept permissive at the wire
 * boundary — the cryptographic validation lives inside
 * `@simplewebauthn/server`; this just pins the envelope shape for OpenAPI and
 * the runtime `safeParse`.
 */
export const webauthnCredentialSchema = z
  .object({
    id: z.string(),
    rawId: z.string(),
    type: z.literal("public-key"),
    response: z.record(z.string(), z.unknown()),
    authenticatorAttachment: z.enum(["platform", "cross-platform"]).optional(),
    clientExtensionResults: z.record(z.string(), z.unknown()).optional(),
  })
  .describe("SimpleWebAuthn ceremony response payload.");

/** A human label for a registered security key (settings + rename). */
export const webauthnKeyNameSchema = z.string().trim().min(1).max(64);

/** Register a security key as a second factor (cookie session, settings). */
export const mfaWebauthnRegisterVerifySchema = z
  .object({
    challengeId: z.string().min(1),
    credential: webauthnCredentialSchema,
    name: webauthnKeyNameSchema.optional(),
  })
  .meta({
    id: "MfaWebauthnRegisterVerifyRequest",
    description:
      "Finish registering a WebAuthn security key as a second factor.",
  });

/** Rename a registered security key. */
export const mfaWebauthnRenameSchema = z
  .object({ name: webauthnKeyNameSchema })
  .meta({ id: "MfaWebauthnRenameRequest" });

/** Begin a mid-login security-key assertion: present the login MFA ticket. */
export const mfaWebauthnLoginOptionsSchema = z
  .object({
    mfaTicket: z
      .string()
      .min(1)
      .describe("The opaque single-use ticket from the login response."),
  })
  .meta({ id: "MfaWebauthnLoginOptionsRequest" });

/** Complete a mid-login security-key assertion. */
export const mfaWebauthnLoginVerifySchema = z
  .object({
    mfaTicket: z.string().min(1),
    challengeId: z.string().min(1),
    credential: webauthnCredentialSchema,
    rememberDevice: z
      .boolean()
      .optional()
      .describe(
        "Opt in to trusting this device for 30 days — subsequent logins skip the second factor (the password is still required).",
      ),
  })
  .meta({
    id: "MfaWebauthnLoginVerifyRequest",
    description:
      "Complete a second-factor login challenge with a WebAuthn security key and receive the same token bundle the password path issues.",
  });
