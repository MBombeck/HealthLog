/**
 * OpenAPI 3.1 base registry (v1.4.23).
 *
 * `zod-openapi` (samchungy) reads Zod v4's
 * native `.meta()` metadata, so we annotate schemas in their original
 * validation files and register the route table here. The committed
 * spec at `docs/api/openapi.yaml` is regenerated via
 * `pnpm openapi:generate`; the CI gate in `.github/workflows/security.yml`
 * runs `pnpm openapi:check` to detect drift.
 *
 * The v1.4.23 baseline covers the 6-8 routes the v1.5 iOS app touches
 * (auth/login, auth/passkey/login-verify, auth/refresh, measurements
 * GET + POST + batch, devices POST, insights/comprehensive). Future
 * waves expand coverage organically as routes are touched. Once the
 * registry catches the rest of the hand-maintained spec, the CI gate
 * flips from `continue-on-error: true` to hard-fail.
 *
 * The registry is intentionally split:
 *   - `openApiBase` carries the static document scaffolding (info,
 *     servers, tags).
 *   - `buildOpenApiDocument` assembles the full spec by importing the
 *     registered route table from `./routes`. Routes live in their own
 *     file so additions don't touch the base.
 */
import { createDocument, type ZodOpenApiObject } from "zod-openapi";

import { openApiPaths, openApiComponents } from "./routes";
import { version as packageVersion } from "../../../package.json";

const openApiBase: Pick<
  ZodOpenApiObject,
  "openapi" | "info" | "servers" | "tags" | "security"
> = {
  openapi: "3.1.0",
  info: {
    title: "HealthLog API",
    // v1.5.1 — pulled from package.json so the spec's info.version
    // tracks the release line automatically. The CI drift gate
    // (`pnpm openapi:check`) catches the case where the registry
    // and the committed spec disagree.
    version: packageVersion,
    description:
      "Self-hosted personal-health-tracking PWA — public API surface for the iOS native client and external ingest.\n\n" +
      "## Date-time contract\n\n" +
      "Every field marked `format: date-time` is an ISO-8601 instant. The schema pattern accepts both `Z` (UTC) and `±HH:MM` (offset) suffixes; clients must accept either. " +
      "Server responses since v1.4.25 emit timestamps with the requesting user's display-timezone offset when a user context exists (exports, doctor-report PDF). Background-job-authored payloads (backups, admin tools) emit `Z`. " +
      "Native iOS clients should always parse via a Foundation ISO-8601 formatter with the `withInternetDateTime` + `withTimeZone` options enabled.",
    license: {
      name: "PolyForm-Noncommercial-1.0.0",
      url: "https://github.com/MBombeck/HealthLog/blob/main/LICENSE",
    },
    contact: { name: "HealthLog", url: "https://healthlog.dev" },
  },
  servers: [
    {
      url: "https://healthlog.example.com",
      description: "Your self-hosted instance",
    },
    { url: "http://localhost:3000", description: "Local dev" },
  ],
  tags: [
    { name: "Auth" },
    { name: "Measurements" },
    { name: "Medications" },
    { name: "Mood" },
    { name: "Analytics" },
    { name: "Insights" },
    { name: "Consent" },
    { name: "Dashboard" },
    { name: "Notifications" },
    { name: "Devices" },
    { name: "Export" },
    { name: "Sync" },
    { name: "Cycle" },
    { name: "MeasurementReminders" },
    { name: "Labs" },
    { name: "Illness" },
    { name: "Documents" },
    { name: "Records" },
    {
      name: "wallet-web-service",
      description:
        "Apple Wallet's pass web service (v1.50): the `webServiceURL` inside an emergency-card pass. Apple's fixed protocol, raw bodies, called by Wallet on the device.",
    },
    { name: "Admin" },
    { name: "Meta" },
    {
      name: "Retired",
      description:
        "Paths that were published and have been removed. They answer 410 Gone with `meta.errorCode` = `route.retired`, the removing version, and the replacement path where there is one. Listed so a client generated from this contract learns the path is gone from the contract rather than from a 404 in production.",
    },
  ],
  /**
   * How a caller authenticates, for every operation that does not say
   * otherwise.
   *
   * The two schemes were defined under `components.securitySchemes` from the
   * start and referenced by nothing — no document-level `security`, none on any
   * operation. That is not a small omission: a client generated from the
   * contract wires neither the `Authorization` header nor the session cookie,
   * and reads the whole surface as an open API. The schemes being present is
   * exactly what hid it, because the obvious check passes.
   *
   * Two entries rather than one object with two keys. In OpenAPI an array is
   * OR and the keys inside one object are AND, so `[{bearerAuth: []},
   * {cookieAuth: []}]` says "a token or a session", which is what the server
   * accepts. One object with both keys would demand both at once.
   *
   * The order is deliberate: a generator that picks the first scheme it
   * understands should reach for the Bearer token, because the native client is
   * the reason this contract is published. The browser has its cookie already.
   *
   * Operations that genuinely take no credential override this with
   * `security: []`; `openapi-security-declaration-guard.test.ts` holds the list
   * of those and fails on an opt-out that is not on it. Note that the proxy's
   * `PUBLIC_PATHS` is a different question and not the list — it says what the
   * edge lets through, not what the handler behind it accepts, and
   * `/api/ingest/medication` is on it while requiring a Bearer token.
   */
  security: [{ bearerAuth: [] }, { cookieAuth: [] }],
};

/**
 * Assemble the full OpenAPI 3.1 document. Routes live in their own
 * file so additions don't touch the base scaffolding. The static
 * import keeps typecheck-narrowing and tree-shaking intact (W6 S-02
 * removed the lazy-`require` form which had no real consumer and was
 * costing an `eslint-disable` + an `as` cast for no benefit).
 */
export function buildOpenApiDocument(): ReturnType<typeof createDocument> {
  return createDocument({
    ...openApiBase,
    paths: openApiPaths,
    components: openApiComponents,
  });
}
