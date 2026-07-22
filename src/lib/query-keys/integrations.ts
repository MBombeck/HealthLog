/**
 * Query keys — external integrations: API tokens, Telegram, Withings,
 * WHOOP, Fitbit, moodLog, and the Apple Health export import job.
 * Part of the centralized factory; aggregated in `./index.ts`.
 */
export const integrationKeys = {
  tokens: () => ["tokens"] as const,
  // v1.22.0 — MCP connector tokens (the dedicated `health:read` scope minted
  // for the remote MCP endpoint). Distinct key from `tokens()` so the MCP
  // settings card's mint / revoke mutations invalidate only this list.
  mcpTokens: () => ["mcp-tokens"] as const,
  // MCP Phase 3 — OAuth connector connections (the revocable unit for a remote
  // client authorized through the OAuth bridge). Distinct from `mcpTokens()` so
  // a connection revoke invalidates only the connection list.
  mcpConnections: () => ["mcp-connections"] as const,
  telegram: () => ["telegram"] as const,
  telegramSettings: () => ["telegram", "settings"] as const,
  withings: () => ["withings"] as const,
  /**
   * v1.4.42 W3-QUERYKEY-LONGTAIL — the per-card Withings status read.
   * Shares the `["withings"]` prefix with `withings()` so a disconnect
   * mutation invalidates both at once.
   */
  withingsStatus: () => ["withings", "status"] as const,
  whoop: () => ["whoop"] as const,
  /**
   * Per-card WHOOP status read. Shares the `["whoop"]` prefix with `whoop()`
   * so a disconnect / credentials mutation invalidates both at once.
   */
  whoopStatus: () => ["whoop", "status"] as const,
  // v1.12.0 — Fitbit/Pixel integration card, mirroring the WHOOP keys.
  fitbit: () => ["fitbit"] as const,
  /**
   * Per-card Fitbit status read. Shares the `["fitbit"]` prefix with `fitbit()`
   * so a disconnect / credentials mutation invalidates both at once.
   */
  fitbitStatus: () => ["fitbit", "status"] as const,

  // v1.27.0 — Google Health (Fitbit + Pixel Watch + Fitbit Air) integration
  // card. Reads status off the consolidated /api/integrations/status envelope
  // (like Fitbit/WHOOP); the connect/disconnect/credentials/sync mutations
  // invalidate this key so the card repaints. Distinct hyphenated array so it
  // never collides with the classic `fitbit` key.
  googleHealth: () => ["google-health"] as const,

  // v1.17.0 — Nightscout CGM integration card. Self-contained status read
  // (not the consolidated /api/integrations/status envelope), so the
  // connect/disconnect mutations invalidate this single key.
  nightscout: () => ["nightscout"] as const,
  nightscoutStatus: () => ["nightscout", "status"] as const,

  // v1.17.0 (F4) — Polar + Oura OAuth integration cards. Self-contained status
  // reads (not the consolidated /api/integrations/status envelope), so the
  // connect/disconnect mutations invalidate these single keys.
  polar: () => ["polar"] as const,
  polarStatus: () => ["polar", "status"] as const,
  oura: () => ["oura"] as const,
  ouraStatus: () => ["oura", "status"] as const,

  // v1.28.x — Strava OAuth integration card. Reads status off the consolidated
  // /api/integrations/status envelope (like WHOOP/Fitbit/Polar/Oura); the
  // connect/disconnect/credentials mutations invalidate this key so the card
  // repaints.
  strava: () => ["strava"] as const,
  stravaStatus: () => ["strava", "status"] as const,

  moodlogStatus: () => ["moodlog-status"] as const,
  integrationsStatus: () => ["integrations", "status"] as const,
  // Apple Health live-sync freshness comes from the existing HealthKit config
  // endpoint. It is intentionally separate from the OAuth integration ledger:
  // a received-data timestamp proves ingest activity, not a web connection.
  healthKitStatus: () => ["integrations", "healthkit"] as const,

  /**
   * v1.15.7 — in-flight Apple Health `export.zip` import. Keyed by the
   * `jobId` returned from `POST /api/import/apple-health-export` so the
   * Export & Import settings area can poll
   * `GET /api/import/apple-health-export/[jobId]/status` with a
   * `refetchInterval` while the job is running and stop on a terminal
   * state. Each upload mints its own key, so a re-upload (or a second
   * archive) never collides with a previous job's cached status.
   */
  importJobStatus: (jobId: string) =>
    ["import", "apple-health", "status", jobId] as const,
};
