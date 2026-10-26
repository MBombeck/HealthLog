/**
 * Every web request to an AI route is behind the `ai` capability map, and no
 * web code reads the retired switch projection.
 *
 * Since v1.39 the web renders every AI surface from one answer, the `ai`
 * block on `GET /api/auth/me`, read through `useAiCapability`. Two ways back
 * to the old behaviour are frozen here:
 *
 *   1. Reading `GET /api/feature-flags` (or the deleted `useFeatureFlags`
 *      hook). The projection knew only the operator's switches, not the
 *      person's opt-out, the provider or the consent, and it failed open, so
 *      AI chrome flashed and fired refusals before the switch set arrived.
 *   2. A request to an AI route from a module nobody gates. Each such module
 *      is on `AI_REQUEST_SITES` with the capability that decides it and the
 *      file that reads that capability; the guard proves the file does read
 *      it. A new module that requests an AI route without an entry fails by
 *      name.
 *
 * Matchers are whitespace-tolerant (`useAiCapability ( "coach" )` counts) and
 * run on comment-stripped source, so prose naming a route or the hook is not
 * a hit. Each discovery asserts a non-zero count: a sweep that finds nothing
 * would agree with every allowlist, so an empty match set fails instead.
 *
 * Its honest limit: it recognises a request by the route literal. A route
 * built from pieces (`"/api/insights/" + name`) or read from a constant in
 * another module would slip it; `AI_ROUTE_PATTERNS` lists the literal shapes
 * the tree uses today.
 */
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { AiCapabilityKey } from "@/lib/ai/capabilities/types";

import {
  readSourceText,
  stripComments,
  walkSourceFiles,
} from "./helpers/source-files";

const SRC = path.resolve(__dirname, "..");

const NON_TEST_FILES = walkSourceFiles(SRC, { floor: 1500 }).filter(
  (rel) =>
    !rel.startsWith("app/api/") &&
    !rel.startsWith("generated/") &&
    !rel.includes("__tests__/") &&
    !/\.test\.tsx?$/.test(rel),
);

/**
 * Web code for the request sweep: pages, components, hooks. `lib/` is left
 * out of that sweep because it mixes server modules (the jobs and route
 * helpers name the same routes) with client ones; the retired-projection
 * check below walks it too, minus the switch loader and the API contract,
 * which describe the route rather than read it.
 */
const CLIENT_FILES = NON_TEST_FILES.filter((rel) => !rel.startsWith("lib/"));

const FEATURE_FLAG_SWEEP = NON_TEST_FILES.filter(
  (rel) =>
    !rel.startsWith("lib/feature-flags/") &&
    !rel.startsWith("lib/openapi/") &&
    // The deprecation registry names the route to date its retirement; it
    // reads nothing from it.
    rel !== "lib/http/deprecation.ts",
);

const read = (rel: string) =>
  stripComments(readSourceText(path.join(SRC, rel)));

/** Request literals of routes that call a model or serve model text. */
const AI_ROUTE_PATTERNS: readonly RegExp[] = [
  /["'`]\/api\/insights\/generate["'`?]/,
  /["'`]\/api\/insights\/\$\{\s*metric\s*\}-status/,
  /["'`]\/api\/insights\/metric-status\?/,
  /["'`]\/api\/insights\/biomarker-assessment\?/,
  /["'`]\/api\/insights\/medication-compliance-status\?/,
  /["'`]\/api\/insights\/coach\/nudge-status["'`]/,
  /["'`]\/api\/insights\/chat["'`]/,
  /["'`]\/api\/insights\/chat\/fenced["'`]/,
  /["'`]\/api\/medications\/extract["'`]/,
  /["'`]\/api\/labs\/ocr\/capability["'`]/,
  /["'`]\/api\/documents\/inbound\/capability["'`]/,
  /["'`]\/api\/ai\/test["'`]/,
];

interface RequestSite {
  capability: AiCapabilityKey | null;
  /** The file that reads the capability and keeps the request from firing. */
  gate: string;
  /** Why, when `capability` is null. */
  reason?: string;
}

/**
 * Every client module that requests an AI route, keyed by path under src/.
 * Adding a request site means adding it here with the capability that decides
 * it; the guard then checks the gate file really reads that capability.
 */
const AI_REQUEST_SITES: Record<string, RequestSite> = {
  "components/insights/use-insights-advisor.ts": {
    capability: "briefing",
    gate: "components/insights/use-insights-advisor.ts",
  },
  "components/settings/ai/runtime-actions-row.tsx": {
    capability: "briefing",
    gate: "components/settings/ai/runtime-actions-row.tsx",
  },
  "hooks/use-insight-status.ts": {
    capability: "statusText",
    gate: "hooks/use-insight-status.ts",
  },
  "app/insights/medications/page.tsx": {
    capability: "statusText",
    gate: "app/insights/medications/page.tsx",
  },
  "components/insights/layout-coach-fab.tsx": {
    capability: "coach",
    gate: "components/insights/layout-coach-fab.tsx",
  },
  "app/coach/page-client.tsx": {
    capability: "coach",
    gate: "app/coach/page-client.tsx",
  },
  // The chat hooks run only inside the drawer, which mounts only while the
  // Coach is available, and on /coach, which leaves while it is not.
  "components/insights/coach-panel/use-coach.ts": {
    capability: "coach",
    gate: "components/insights/layout-coach-mount.tsx",
  },
  "components/medications/scheduling/natural-language-extractor.tsx": {
    capability: "medicationExtract",
    gate: "components/medications/wizard/medication-wizard-dialog.tsx",
  },
  "components/labs/use-ocr-extract.ts": {
    capability: "labsOcr",
    gate: "app/labs/page.tsx",
  },
  "components/documents/use-document-assist.ts": {
    capability: "documentAi",
    gate: "components/documents/detail/use-document-detail-ai.ts",
  },
};

/** Requests to AI routes that no capability decides, with the reason. */
const UNGATED_BY_DESIGN: Record<string, string> = {
  // `POST /api/ai/test` checks a provider before anything can be on; the
  // route answers the operator's master switch itself with a typed refusal.
  "components/settings/ai/runtime-actions-row.tsx:/api/ai/test":
    "the connection test is how a provider gets checked",
};

function readsCapability(source: string, key: AiCapabilityKey): boolean {
  return new RegExp(
    `useAiCapability(?:Answer)?\\s*\\(\\s*["']${key}["']\\s*\\)`,
  ).test(source);
}

describe("AI surfaces read the capability map", () => {
  it("walks the web tree", () => {
    expect(CLIENT_FILES.length).toBeGreaterThan(800);
  });

  it("no web code reads GET /api/feature-flags or the retired hook", () => {
    expect(FEATURE_FLAG_SWEEP.length).toBeGreaterThan(1500);
    const offenders = FEATURE_FLAG_SWEEP.filter((rel) => {
      const src = read(rel);
      return (
        /["'`]\/api\/feature-flags/.test(src) ||
        /["']@\/hooks\/use-feature-flags["']/.test(src) ||
        /\buseFeatureFlags\s*\(/.test(src)
      );
    });
    expect(offenders).toEqual([]);
  });

  it("every request to an AI route comes from a registered, gated module", () => {
    const discovered = CLIENT_FILES.filter((rel) => {
      const src = read(rel);
      return AI_ROUTE_PATTERNS.some((pattern) => pattern.test(src));
    });
    // A sweep that finds nothing agrees with every registry.
    expect(discovered.length).toBeGreaterThanOrEqual(8);

    const unregistered = discovered.filter((rel) => !(rel in AI_REQUEST_SITES));
    expect(
      unregistered,
      "Module(s) request an AI route but are not on AI_REQUEST_SITES",
    ).toEqual([]);

    const stale = Object.keys(AI_REQUEST_SITES).filter(
      (rel) => !discovered.includes(rel),
    );
    expect(stale, "AI_REQUEST_SITES entries that no longer request").toEqual(
      [],
    );
  });

  it("each registered gate reads the capability it names", () => {
    const missing = Object.entries(AI_REQUEST_SITES)
      .filter(([, site]) => site.capability !== null)
      .filter(([, site]) => !readsCapability(read(site.gate), site.capability!))
      .map(([rel, site]) => `${rel} -> ${site.gate} (${site.capability})`);
    expect(missing).toEqual([]);
  });

  it("the ungated exceptions are real", () => {
    for (const key of Object.keys(UNGATED_BY_DESIGN)) {
      const [rel, route] = key.split(":");
      expect(read(rel)).toContain(route);
    }
  });

  it("the account payload's ai block has web readers beyond the hook", () => {
    const readers = CLIENT_FILES.filter((rel) =>
      /useAiCapability(?:Answer|Map)?\s*\(/.test(read(rel)),
    ).filter((rel) => rel !== "hooks/use-ai-capability.ts");
    expect(readers.length).toBeGreaterThanOrEqual(20);
  });
});
