/**
 * The `MeasurementSource` values, as plain data.
 *
 * Kept out of `@/lib/validations/measurement` so a client surface that only
 * needs the list (the source labels, the measurement list's URL filter) does
 * not pull Zod into its route's first load. The Zod enum in the validation
 * module is built from this list, so the two cannot drift.
 */
export const MEASUREMENT_SOURCES = [
  "MANUAL",
  "WITHINGS",
  "IMPORT",
  "APPLE_HEALTH",
  // v1.10.0 — computed scores (WX-C). Server-owned / read-only: a `COMPUTED`
  // row is minted by a nightly engine, never written by a client. It is part
  // of this enum so the read/response shapes (and the iOS decoder) can decode
  // the rows it surfaces; the client-facing write surfaces reject it — see
  // `WRITABLE_MEASUREMENT_SOURCES` and the batch route's `batchSourceEnum`.
  "COMPUTED",
  // v1.11.0 — WHOOP integration. Native WHOOP scores ingest server-side (no
  // client write path). Part of this enum so the read/response shapes (and
  // the iOS decoder) can decode the rows it surfaces.
  "WHOOP",
  // v1.12.0 — Fitbit/Pixel integration via the Google Health API. Server-owned
  // (no client write path), exactly like WHOOP. Part of this enum so the
  // read/response shapes (and the iOS decoder) can decode the rows it surfaces.
  "FITBIT",
  // v1.17.0 — Nightscout glucose integration (F1). Server-owned (no client
  // write path), exactly like WHOOP/FITBIT. Part of this enum so the
  // read/response shapes (and the iOS decoder) can decode the rows it surfaces.
  "NIGHTSCOUT",
  // v1.17.0 — Polar OAuth integration (F4). Server-owned (no client write
  // path), exactly like WHOOP/FITBIT. Part of this enum so the read/response
  // shapes (and the iOS decoder) can decode the rows it surfaces.
  "POLAR",
  // v1.17.0 — Oura OAuth integration (F4). Server-owned (no client write
  // path), exactly like WHOOP/FITBIT. Part of this enum so the read/response
  // shapes (and the iOS decoder) can decode the rows it surfaces.
  "OURA",
  // v1.19.2 — Telegram numeric-reply capture. A reply to a measurement
  // reminder is written server-side from the chat-bound webhook (not the
  // cookie/Bearer client write path), so it carries its own source label.
  // Part of this enum so the read/response shapes (and the iOS decoder) can
  // decode the rows it surfaces; the client-facing write surfaces still
  // reject it (see `WRITABLE_MEASUREMENT_SOURCES` + the batch allowlist).
  "TELEGRAM",
  // v1.22.0 — measurements logged through the confirmed remote MCP write
  // surface under a `health:write`-scoped token. Server-resolved (the row is
  // written in-process over `/mcp`, never through the cookie/Bearer client
  // write path), so it is excluded from `WRITABLE_MEASUREMENT_SOURCES`; part
  // of this enum so the read/response shapes (and the iOS decoder) can decode
  // the rows it surfaces.
  "MCP",
  // v1.26.0 — Fitbit/Pixel + Wear OS via the Google Health API. Server-owned
  // (no client write path), exactly like WHOOP/FITBIT. Part of this enum so the
  // read/response shapes (and the iOS decoder) can decode the rows it surfaces;
  // deliberately absent from `WRITABLE_MEASUREMENT_SOURCES` + the batch
  // allowlist so a client can never forge a GOOGLE_HEALTH-attributed row.
  "GOOGLE_HEALTH",
  // v1.28.x — Strava OAuth integration. Native Strava activities ingest
  // server-side as `source = STRAVA` Workout rows (no client write path),
  // exactly like WHOOP/FITBIT. Part of this enum so the read/response shapes
  // (and the iOS decoder) can decode the rows it surfaces; deliberately absent
  // from `WRITABLE_MEASUREMENT_SOURCES` + the batch allowlist so a client can
  // never forge a STRAVA-attributed row.
  "STRAVA",
  // v1.38.x — measurements pushed in under a `measurements:write` Bearer
  // token (a home-automation bridge, a scale's own uploader). Server-resolved
  // from the credential rather than named by the caller, so it is deliberately
  // absent from `WRITABLE_MEASUREMENT_SOURCES` and the batch allowlist — a
  // source a client could assert would prove nothing about where the reading
  // came from. Part of this enum so the read/response shapes (and the iOS
  // decoder) can decode the rows it surfaces. Unlike the server-owned sources
  // above these rows stay value-editable; see
  // `USER_CORRECTABLE_MEASUREMENT_SOURCES`.
  "EXTERNAL",
  // v1.42 — rows imported from an Android Health Connect export (#972).
  // Server-owned: only the Health Connect import worker writes them, so the
  // value is deliberately absent from `WRITABLE_MEASUREMENT_SOURCES` and the
  // batch allowlist, like IMPORT. Part of this enum so the read/response
  // shapes (and the iOS decoder) can decode the rows it surfaces.
  "HEALTH_CONNECT",
  // Garmin Personal API (#1333). Server-owned: only the Garmin sync
  // writes these rows, so the value is absent from
  // `WRITABLE_MEASUREMENT_SOURCES` and the batch allowlist like every other
  // provider. Part of this enum so the read/response shapes (and the iOS
  // decoder) can decode the rows it surfaces.
  "GARMIN",
] as const;
