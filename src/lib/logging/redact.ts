/**
 * Redact secrets from strings before they leave the process boundary
 * (Loki, Glitchtip, console). Applied in `WideEventBuilder.setError()`,
 * `WideEventBuilder.setHttp()`, and `reportToGlitchtip()` so every
 * value reaching observability is scrubbed once, centrally.
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
 *   - `sk-…` and `sk-ant-…` — OpenAI / Anthropic API keys. We never
 *     log them on purpose, but a misconfigured client error or a
 *     dump of the request body could carry one. Scrub before egress.
 *   - path-segment secrets — routes like `/api/withings/webhook/<secret>`
 *     and the clinician share view `/c/<hls_…>` carry a bearer secret as
 *     a positional path segment. The Wide Event `http.path` and
 *     `http.route` fields would otherwise leak the secret into stdout,
 *     the in-memory ring buffer, and Loki. See `PATH_SECRET_PATHS`.
 *
 * The substitution is intentionally generic ([REDACTED]) — we don't
 * want partial revelation of token entropy.
 */
/**
 * Registry of path prefixes where the trailing segment is a shared
 * secret. Each entry's `prefix` must end with `/`; any non-empty
 * segment after it is rewritten to `[REDACTED]`. Subsequent path
 * segments are preserved (so `/foo/<secret>/bar` becomes
 * `/foo/[REDACTED]/bar`).
 *
 * Add a new entry whenever a route exposes a secret in its URL path
 * (rather than headers, body, or query). Tested in `redact.test.ts`.
 */
export const PATH_SECRET_PATHS: ReadonlyArray<{
  prefix: string;
  /**
   * Match the prefix only where a path STARTS with it, not inside a longer
   * path. Needed when the prefix is also the tail of an unrelated route:
   * `/claim/` is both the handover link and the end of `/api/auth/claim/`,
   * whose `preview` segment is a route name, not a secret.
   */
  pathStart?: true;
}> = [
  // Withings webhook entrypoint: `WITHINGS_WEBHOOK_SECRET` travels as
  // the trailing path segment (v1.4.25 W17a). Without this rule the
  // secret lands in every Wide Event's `http.path` / `http.route`.
  { prefix: "/api/withings/webhook/" },
  // v1.11.0 — clinician share view (Epic C). The raw `hls_` share token
  // rides as the trailing path segment of `/c/<token>`; it is a bearer
  // credential for the share surface, so scrub it from `http.path` /
  // `http.route` the same way the Withings webhook secret is scrubbed.
  { prefix: "/c/" },
  // v1.11.0 — WHOOP webhook entrypoint: `WHOOP_WEBHOOK_SECRET` travels as
  // the trailing path segment (mirrors Withings). Without this rule the
  // secret lands in every Wide Event's `http.path` / `http.route`.
  { prefix: "/api/whoop/webhook/" },
  // v1.42 (#959) — managed-profile handover link. The raw `hlp_` token rides
  // as the trailing path segment of `/claim/<token>` until the proxy turns it
  // into `/auth/claim?token=…` (scrubbed by the `token=` query rule below);
  // it is a one-time credential that turns a profile into an account.
  // `pathStart`, because `/api/auth/claim/preview` ends in the same prefix
  // and its last segment is a route name. A full URL carrying the token is
  // still scrubbed, by the `hlp_` rule in `redactSecrets`.
  { prefix: "/claim/", pathStart: true },
];

function redactPathSegments(input: string): string {
  let out = input;
  for (const { prefix, pathStart } of PATH_SECRET_PATHS) {
    // Match `<prefix><segment>` where `<segment>` is one or more
    // non-`/` non-`?` chars, then preserve anything after (next path
    // segment, query string, hash). Capture group 1 is the optional
    // trailing context starting with `/`, `?`, or `#`.
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const start = pathStart ? "(?<![A-Za-z0-9_.-])" : "";
    const re = new RegExp(`${start}${escaped}[^/?#\\s]+([/?#][^\\s]*)?`, "g");
    out = out.replace(re, (_match, tail: string | undefined) => {
      return `${prefix}[REDACTED]${tail ?? ""}`;
    });
  }
  return out;
}

export function redactSecrets(input: string): string {
  return (
    redactPathSegments(input)
      .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
      .replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot[REDACTED]")
      // `sk-` is a common English-prefix substring (task-force, risk-
      // management, disk-io). Without a word-boundary, the original
      // `/sk-(?:ant-)?[A-Za-z0-9_-]+/g` over-matched and made server logs
      // unreadable. Require the `sk-` token to be at the start of the
      // string OR preceded by a non-alphanumeric character (whitespace,
      // `=`, `{`, `,`, `:`, etc.). The minimum length-8 tail keeps a
      // tiny safety margin against `sk-1`-style false-positives in code
      // identifiers. Capture group 1 = the leading separator (preserved).
      .replace(/(^|[^A-Za-z0-9])sk-(?:ant-)?[A-Za-z0-9_-]{8,}/g, "$1[REDACTED]")
      // HealthLog hex-bodied credentials: `hlk_` access token, `hlr_` refresh
      // token, `hls_` session cookie secret (v1.30.32) and clinician share
      // token, `hle_` step-up elevation (v1.30.34), `hlv_` registration invite,
      // `hlp_` managed-profile handover link (v1.42).
      // Same boundary-aware shape as the `sk-` rule. The
      // idempotency replay-cache already rejects bodies containing
      // these prefixes (CLAUDE.md headless-client-API patterns); this
      // is the matching egress guard for log/error surfaces.
      .replace(/(^|[^A-Za-z0-9])hl[kpresv]_[A-Fa-f0-9]{32,}/g, "$1[REDACTED]")
      // v1.22.0 — the MCP OAuth bridge artifacts: the authorization code
      // (`hlac_`), refresh token (`hlrt_`), and DCR client id (`hlc_`). All
      // are signed, base64url-bodied, and credential-bearing, so they are
      // scrubbed at the egress boundary like the native token formats above.
      // `hlh_` is the one-time native sign-in handoff code, base64url too; it
      // rides a custom-scheme redirect and is exchanged for a token pair.
      .replace(
        /(^|[^A-Za-z0-9])hl(?:ac|rt|c|h)_[A-Za-z0-9_.-]{16,}/g,
        "$1[REDACTED]",
      )
      // v1.7.0 — `insurance`/`insuranceNumber`/`kvnr` (German statutory-
      // insurance number) added as defence-in-depth: the value is
      // encrypted at rest and never deliberately logged, but a stray
      // query-string leak (`?kvnr=…`) is scrubbed at the egress boundary.
      // v1.12.2 — `ticket` (the one-time WHOOP connect ticket rides in the
      // `GET /api/whoop/connect?ticket=…` URL): scrub it so the opaque value
      // never lands in `http.path`/error strings reaching Loki/Glitchtip.
      // v1.23 — second-factor / account-recovery / encrypted-export material.
      // `totp`/`mfa` tickets-or-codes, `backup_code` / `recovery_code`, and the
      // `passphrase` that derives the encrypted-export key must never land in
      // `http.path` / error strings reaching Loki / Glitchtip.
      .replace(
        /([?&])(secret|code|token|ticket|api[_-]?key|license[_-]?key|insurance(?:number)?|kvnr|totp|mfa|backup[_-]?code|recovery[_-]?code|passphrase)=[^&\s]+/gi,
        "$1$2=[REDACTED]",
      )
  );
}

/** Apply `redactSecrets` to a possibly-undefined string. */
export function redactOptional(s: string | undefined): string | undefined {
  return s === undefined ? undefined : redactSecrets(s);
}
