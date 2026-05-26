/**
 * Should the `Secure` flag be set on session-class cookies?
 *
 * Default — the flag is on whenever `NODE_ENV === "production"`, which
 * is the safe choice for any deployment terminated by HTTPS (the
 * documented self-hosting path: Caddy / Traefik / Nginx in front).
 *
 * Opt-out — operators running plain HTTP on a LAN or private VPN can
 * set `SESSION_COOKIE_SECURE=false` to drop the flag. Without the flag
 * a browser will send the cookie back over HTTP, so login round-trips
 * complete on `http://10.x.x.x:3000` and friends. This is intentional
 * for evaluation, NAS / homelab deployments, and Tailscale-only
 * surfaces; it is NOT appropriate for a deployment that ever serves
 * plain HTTP to the open internet, because the session cookie then
 * crosses the wire in cleartext.
 *
 * Opt-in — `SESSION_COOKIE_SECURE=true` forces the flag on even under
 * `NODE_ENV !== "production"`, useful when a developer fronts their
 * `pnpm dev` server with HTTPS for testing the production cookie path.
 *
 * The function is intentionally stateless / re-evaluated per call so a
 * runtime env change (e.g. via `compose.yml` edit + `docker compose up
 * -d`) takes effect on the next request without an app restart.
 */
export function shouldEmitSecureCookie(): boolean {
  const override = process.env.SESSION_COOKIE_SECURE?.trim().toLowerCase();
  if (override === "false") return false;
  if (override === "true") return true;
  return process.env.NODE_ENV === "production";
}
