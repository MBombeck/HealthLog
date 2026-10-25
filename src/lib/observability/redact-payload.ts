/**
 * v1.4.49 — sensitive-field redactor for observability payloads.
 *
 * The v1.4.48 H-iOS-1 / H-iOS-2 work surfaces a 256-char truncated
 * `JSON.stringify` of the request body to the wide-event
 * `meta.received_shape_excerpt`. Today's iOS surface (widget layout +
 * series query) only carries enum / boolean / int fields so a verbatim
 * excerpt is safe, but the pattern is heading for routes that accept
 * tokens (APNs registration, Withings re-auth, API tokens) and bearer
 * credentials. Pre-empt the leak: every body that flows into a
 * wide-event excerpt is first walked through `redactSensitiveFields`,
 * which replaces any key matching one of the `SENSITIVE_KEY_PATTERNS`
 * regexes with the literal string `"[redacted]"`.
 *
 * Adding a new sensitive token is a one-line append to
 * `SENSITIVE_KEY_PATTERNS`. The match is case-insensitive and runs
 * against the literal key name, so `apnsToken`, `bearerToken`,
 * `APIKey`, `Authorization` and `csrf_state` all redact without
 * extra spellings.
 *
 * The redactor recurses into nested objects + arrays so deeply-nested
 * credentials (e.g. `{ creds: { password: "…" } }`) are caught the
 * same way. Non-object scalar inputs pass through unchanged — the
 * caller's `JSON.stringify` then truncates as before.
 */

export const SENSITIVE_KEY_PATTERNS: readonly RegExp[] = [
  /password/i,
  /passphrase/i,
  /token/i,
  /secret/i,
  /apikey/i,
  /api[_-]key/i,
  /authorization/i,
  /csrfstate/i,
  /csrf[_-]state/i,
  /nonce/i,
  // Credential-adjacent keys that aren't already covered by the broader
  // `token` / `secret` patterns. TOTP / email-OTP one-time codes,
  // account-recovery codes, and the observability DSNs that double as
  // auth (Glitchtip / Sentry-style `https://<key>@host`) all carry
  // material worth keeping out of wide-event excerpts.
  /otp/i,
  /recovery/i,
  /dsn/i,
  // v1.23 — second-factor / account-recovery material. `/otp/i` already
  // catches `totp`/`otpauth` and `/recovery/i` already catches
  // `recoveryCode`, but the explicit `/totp/i`, `/mfa/i`, `/backup.?code/i`,
  // `/recovery.?code/i` keep MFA secrets / recovery codes / the TOTP
  // `otpauth://` URI off every wide-event excerpt regardless of field
  // spelling. `passphrase` (the encrypted-export key) is covered above.
  /totp/i,
  /mfa/i,
  /backup.?code/i,
  /recovery.?code/i,
  // v1.7.0 — health-insurance identity. `insuranceNumber` / `kvnr`
  // (the German statutory-insurance number) is encrypted at rest and is
  // absent from every current wide-event excerpt, but the field name
  // belongs on the denylist as defence-in-depth: if a future change
  // routes a profile body through `buildPayloadDiagnostic` /
  // `redactSensitiveFields`, the value redacts instead of landing
  // verbatim. Also covers `insurerName`.
  /insurance/i,
  /insurer/i,
  /kvnr/i,
  // v1.15.0 — reproductive-health intent fields (the post-Dobbs threat
  // model's highest-sensitivity category). These are encrypted at rest in the
  // sensitive-category envelope and no cycle route currently routes its body
  // through `buildPayloadDiagnostic`, so this is defence-in-depth: if a future
  // change ever excerpts a cycle request body, the intent values redact rather
  // than land verbatim. (`flow`/`note` are too generic to add safely.)
  /sexualactivity/i,
  /protectedsex/i,
  /pregnancytest/i,
  /progesteronetest/i,
  /contraceptive/i,
  /cervicalmucus/i,
  // v1.17.1 — the webhook shared secret. `headerValue` lives only inside the
  // AES-GCM-encrypted `NotificationChannel.config` blob and the GET masks it
  // to `hasHeaderValue`, so no current path excerpts it. Defence-in-depth: if
  // a future change routes a webhook body through `buildPayloadDiagnostic`,
  // the secret redacts instead of landing verbatim. The Live Activity push
  // token is already covered by `/token/i`.
  /headervalue/i,
  // v1.19.0 — the Telegram chat id. It is the de-facto account-binding
  // credential for the bot (the webhook resolves the user by stored
  // `telegramChatId`) and a stable personal identifier, so it belongs out
  // of wide-event excerpts. Matches `telegramChatId` / `telegram_chat_id`
  // / `chatId` / `chat_id`. The bot token is already covered by `/token/i`.
  /telegramchatid/i,
  /telegram[_-]?chat[_-]?id/i,
  /chatid/i,
  /chat[_-]id/i,
  // v1.22.0 — the PKCE `code_verifier` (the proof-of-possession secret the MCP
  // OAuth token endpoint receives). `access_token` / `refresh_token` /
  // `client_secret` are already covered by `/token/i` + `/secret/i`; the
  // verifier is the one secret-shaped key those patterns miss.
  /verifier/i,
  // v1.40.0 — the encryption key an admin pastes into "Check my copy", and the
  // copy of any recovery kit key, sent as `keyCopy`
  // (`POST /api/admin/recovery-kit/verify`). The route never logs its body;
  // this keeps it out of any excerpt a future change might take. Anchored so
  // `encryptionKeyId` and friends stay readable.
  /^encryption[_-]?key$/i,
  /^key[_-]?copy$/i,
];

/**
 * v1.25 — keys whose VALUE must be kept out of a wide-event excerpt but which
 * are too generic to live on the global `SENSITIVE_KEY_PATTERNS` denylist:
 * redacting every `note` / `notes` everywhere `redactSensitiveFields` runs
 * would over-redact unrelated observability. These apply ONLY on the
 * excerpt path via {@link redactForExcerpt}, where a verbatim free-text health
 * note (now encrypted at rest) must never land in `received_shape_excerpt`.
 * Anchored so only the exact `note` / `notes` keys match — not, say, `noteId`
 * or `footnotes`.
 */
export const EXCERPT_ONLY_KEY_PATTERNS: readonly RegExp[] = [/^notes?$/i];

const REDACTED = "[redacted]";

function keyIsSensitive(key: string): boolean {
  for (const re of SENSITIVE_KEY_PATTERNS) {
    if (re.test(key)) return true;
  }
  return false;
}

function keyIsExcerptSensitive(key: string): boolean {
  for (const re of EXCERPT_ONLY_KEY_PATTERNS) {
    if (re.test(key)) return true;
  }
  return false;
}

/**
 * Deep clone of `body` with any key matching `isSensitive` replaced by the
 * literal `"[redacted]"`. Arrays + plain objects are recursed into; scalars,
 * `null`, `undefined`, `Date` and other non-plain objects pass through
 * unchanged. The clone is intentionally shallow on non-plain-object boundaries
 * so the helper stays cheap on the hot 422 path; the only goal is to keep the
 * matched key's value out of the eventual JSON excerpt.
 */
function redactWith(
  body: unknown,
  isSensitive: (key: string) => boolean,
): unknown {
  if (body === null || body === undefined) return body;
  if (Array.isArray(body)) {
    return body.map((entry) => redactWith(entry, isSensitive));
  }
  if (typeof body !== "object") return body;
  // Skip non-plain objects (Date, Map, Set, Buffer, ...) — they'll
  // serialise to a benign form via JSON.stringify and we don't want to
  // walk into framework internals.
  const proto = Object.getPrototypeOf(body);
  if (proto !== Object.prototype && proto !== null) return body;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (isSensitive(key)) {
      out[key] = REDACTED;
      continue;
    }
    out[key] = redactWith(value, isSensitive);
  }
  return out;
}

/**
 * Returns a deep clone of `body` with any key matching the sensitive
 * denylist replaced by the literal `"[redacted]"`.
 */
export function redactSensitiveFields(body: unknown): unknown {
  return redactWith(body, keyIsSensitive);
}

/**
 * v1.25 — excerpt-path redactor. Applies the global sensitive denylist PLUS
 * the excerpt-only `note` / `notes` keys, so a free-text health-note value can
 * never reach the `received_shape_excerpt` verbatim. Use this — not
 * `redactSensitiveFields` — for anything that feeds `buildPayloadDiagnostic`.
 */
export function redactForExcerpt(body: unknown): unknown {
  return redactWith(
    body,
    (key) => keyIsSensitive(key) || keyIsExcerptSensitive(key),
  );
}
