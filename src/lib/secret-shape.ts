/**
 * One definition of "this text carries a credential HealthLog or a common
 * AI provider mints", shared by every surface that refuses to store or echo
 * such text.
 *
 *   `hlk_` access tokens, `hlr_` refresh tokens, `hls_` clinician share-link
 *   tokens and session secrets, `hlv_` registration invite tokens, `hlp_`
 *   managed-profile handover tokens (v1.42), `hle_`
 *   elevation tokens, `hlh_` native sign-in handoff codes, and the MCP OAuth
 *   artifacts `hlac_` (authorization code), `hlrt_` (refresh token) and `hlc_`
 *   (client id);
 *   `sk-…` / `sk-ant-…` OpenAI and Anthropic keys, in the full token form
 *   only: a bare `sk-` substring ("task-id", "risk-management") is not a key,
 *   and matching it would refuse benign text.
 *
 * It is a shape test, not a secret detector. A credential without one of
 * these prefixes (a relay's own app token, a password) passes, so a caller
 * that knows the secrets in play must also refuse text containing them.
 */
const SECRET_SHAPED =
  /(?:\b(?:hlk_|hlr_|hls_|hlv_|hlp_|hle_|hlh_|hlac_|hlrt_|hlc_)[A-Za-z0-9_-]+|\bsk-(?:ant-)?[A-Za-z0-9_-]{8,})/;

export function looksSecretShaped(text: string): boolean {
  return SECRET_SHAPED.test(text);
}
