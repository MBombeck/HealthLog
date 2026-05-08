/**
 * Redact secrets from strings before they leave the process boundary
 * (Loki, Glitchtip, console). Applied in `WideEventBuilder.setError()`
 * and `reportToGlitchtip()` so every error reaching observability is
 * scrubbed once, centrally.
 *
 * Patterns:
 *   - `Bearer <token>` — generic API tokens incl. our `hlk_` /
 *     `hlr_` formats and external OAuth bearers (Withings, AI providers).
 *   - `bot<digits>:<token>` — Telegram bot URLs embed the token in the
 *     path: `https://api.telegram.org/bot1234567:ABC-…/sendMessage`.
 *     If `fetch()` rejects with a `cause` that surfaces the URL (some
 *     Node runtimes), the token would land in error reports.
 *   - `?secret=…` and `?code=…` — query-string leaks for legacy
 *     Withings webhooks and OAuth callbacks (already scrubbed at the
 *     URL level in `reportToGlitchtip`, but error.message can carry
 *     the URL too).
 *
 * The substitution is intentionally generic ([REDACTED]) — we don't
 * want partial revelation of token entropy.
 */
export function redactSecrets(input: string): string {
  return input
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot[REDACTED]")
    .replace(
      /([?&])(secret|code|token|api[_-]?key)=[^&\s]+/gi,
      "$1$2=[REDACTED]",
    );
}

/** Apply `redactSecrets` to a possibly-undefined string. */
export function redactOptional(s: string | undefined): string | undefined {
  return s === undefined ? undefined : redactSecrets(s);
}
