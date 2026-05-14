/**
 * OpenAPI 3.1 base registry (v1.4.23 / Wave 4 F5a).
 *
 * Per the W1 stream-3 decision: `zod-openapi` (samchungy) reads Zod v4's
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

export const openApiBase: Pick<
  ZodOpenApiObject,
  "openapi" | "info" | "servers" | "tags"
> = {
  openapi: "3.1.0",
  info: {
    title: "HealthLog API",
    version: "1.4.23",
    description:
      "Self-hosted personal-health-tracking PWA — public API surface for the iOS native client and external ingest.\n\n" +
      "## Date-time contract\n\n" +
      "Every field marked `format: date-time` is an ISO-8601 instant. The schema pattern accepts both `Z` (UTC) and `±HH:MM` (offset) suffixes; clients must accept either. " +
      "Server responses since v1.4.25 emit timestamps with the requesting user's display-timezone offset when a user context exists (exports, doctor-report PDF). Background-job-authored payloads (backups, admin tools) emit `Z`. " +
      "Native iOS clients should always parse via a Foundation ISO-8601 formatter with the `withInternetDateTime` + `withTimeZone` options enabled.",
    license: {
      name: "AGPL-3.0",
      url: "https://github.com/MBombeck/HealthLog/blob/main/LICENSE",
    },
    contact: { name: "HealthLog", url: "https://healthlog.dev" },
  },
  servers: [
    { url: "https://healthlog.bombeck.io", description: "Production" },
    { url: "http://localhost:3000", description: "Local dev" },
  ],
  tags: [
    { name: "Auth" },
    { name: "Measurements" },
    { name: "Medications" },
    { name: "Mood" },
    { name: "Insights" },
    { name: "Notifications" },
    { name: "Devices" },
    { name: "Admin" },
  ],
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
