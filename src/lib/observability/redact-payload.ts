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
];

const REDACTED = "[redacted]";

function keyIsSensitive(key: string): boolean {
  for (const re of SENSITIVE_KEY_PATTERNS) {
    if (re.test(key)) return true;
  }
  return false;
}

/**
 * Returns a deep clone of `body` with any key matching the sensitive
 * denylist replaced by the literal `"[redacted]"`. Arrays + plain
 * objects are recursed into; scalars, `null`, `undefined`, `Date` and
 * other non-plain objects pass through unchanged.
 *
 * The clone is intentionally shallow on non-plain-object boundaries so
 * the helper stays cheap on the hot 422 path; the only goal is to keep
 * the credentialed key's value out of the eventual JSON excerpt.
 */
export function redactSensitiveFields(body: unknown): unknown {
  if (body === null || body === undefined) return body;
  if (Array.isArray(body)) {
    return body.map((entry) => redactSensitiveFields(entry));
  }
  if (typeof body !== "object") return body;
  // Skip non-plain objects (Date, Map, Set, Buffer, ...) — they'll
  // serialise to a benign form via JSON.stringify and we don't want to
  // walk into framework internals.
  const proto = Object.getPrototypeOf(body);
  if (proto !== Object.prototype && proto !== null) return body;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (keyIsSensitive(key)) {
      out[key] = REDACTED;
      continue;
    }
    out[key] = redactSensitiveFields(value);
  }
  return out;
}
