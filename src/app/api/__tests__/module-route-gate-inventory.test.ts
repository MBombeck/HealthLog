import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { MODULE_KEYS, type ModuleKey } from "@/lib/modules/registry";

/**
 * v1.18.0 — module API route gate inventory.
 *
 * The v1.18.0 module retrofit can hide a toggleable module across the
 * nav, dashboard tiles, Insights pills, reminder jobs, doctor-report
 * sections, and the AI surfaces. The ONE server-side enforcement point
 * is `@/lib/modules/gate` — `requireModuleEnabled(userId, key)` in API
 * routes, `isModuleEnabled` / `resolveModuleMap` in builders + jobs +
 * components. Without a discovery test, a future contributor who lands a
 * new per-domain route for a toggleable module (a new mood-analysis read,
 * a new sleep view, a new glucose panel) would have to remember the gate
 * by hand. A silent miss leaks the surface over a Bearer token even when
 * the account — or the operator — turned the module off.
 *
 * This test walks every per-domain route tree that serves a TOGGLEABLE
 * module and pins each `route.ts` into exactly one of these buckets:
 *
 *   1. MODULE-GATED — the file calls `requireModuleEnabled(...)` for the
 *      right key (mood / sleep / glucose / workouts / recovery / labs /
 *      achievements). This is the direct gate.
 *
 *   2. DELEGATED — the module's enabled-state is owned elsewhere and the
 *      route gates on that single source of truth instead of re-deriving
 *      it (no double source of truth, mirroring the registry's
 *      `delegatesTo`):
 *        - cycle  → `requireCycleEnabled(...)` (the cycle gate the
 *                   `cycle` ModuleKey delegates to).
 *        - coach  → `requireAssistantSurface("coach")` (the assistant
 *                   master flag + per-user opt-out the `coach` ModuleKey
 *                   delegates to). Covered in depth by the sibling
 *                   `coach-route-gate-inventory.test.ts`; listed here so
 *                   coach-bearing routes are not flagged as ungated.
 *
 *   3. EXEMPT — an explicit, COMMENTED allowlist of routes that serve a
 *      toggleable domain but are deliberately NOT gated, each with the
 *      reason at the entry. The two reasons in play:
 *        - DATA LAYER: raw CRUD over the domain's own rows. Writing or
 *          reading a disabled module's data is harmless — the module gate
 *          governs whether the domain SURFACES (nav, tiles, analysis,
 *          reports), not whether the row store accepts writes. Disabling
 *          a module must not wedge an importer / sync / the user's ability
 *          to clean up data, and re-enabling must find the data intact.
 *        - INFRA / UI-ONLY: settings, availability probes, and the static
 *          FHIR CapabilityStatement carry no module data.
 *
 * Anything that doesn't fit one of the three buckets is an orphan and
 * fails the test BY NAME so the fix is one search-and-add: gate the route
 * or move it onto the EXEMPT allowlist with a documented reason.
 *
 * WHAT THIS TEST DOES NOT PROVE, AND WHO PROVES IT
 * -----------------------------------------------
 * This file is a DISCOVERY test: it proves no route escapes classification.
 * It cannot prove a gate actually refuses, because it only reads source text.
 *
 * That distinction used to be blurred. A fourth "BUILDER-GATED" bucket
 * accepted the mere MENTION of an aggregator's name (`loadFhirContext`,
 * `collectDoctorReportData`) as proof that the route was gated. It was not
 * proof of anything: `loadFhirContext` filtered per-domain modules but never
 * evaluated `doctorReport`, so all five `/api/fhir/*` data routes sat in a
 * green bucket while serving the whole record — including the decrypted
 * insurance number — to an account that had the doctor-report module off.
 * The bucket is gone. A route is now only counted as gated when it CALLS a
 * gate, and `REQUIRED_TREE_MODULE` below pins which key it must name.
 *
 * The behaviour itself — a disabled module actually producing a 403 or an
 * omission — is proven by the per-surface tests listed in
 * `BEHAVIOURAL_GATE_TESTS`. This test asserts those files still exist, so
 * deleting the behavioural coverage fails here with a pointer to what was
 * lost rather than silently leaving only a text-match behind.
 */

/**
 * The per-domain route trees that serve a toggleable module. Each entry
 * is a directory under `src/app/api`; every `route.ts` beneath it is
 * enumerated and classified. A domain that is owned entirely by one
 * builder (doctor-report / FHIR) or one delegated gate (cycle) is still
 * walked so a NEW route in the tree must justify itself.
 */
const MODULE_ROUTE_TREES: ReadonlyArray<string> = [
  "src/app/api/mood",
  "src/app/api/mood-entries",
  "src/app/api/sleep",
  "src/app/api/workouts",
  "src/app/api/labs",
  // v1.18.1 — the user-scoped Biomarker catalog backs the Labs feature.
  "src/app/api/biomarkers",
  "src/app/api/cycle",
  // v1.18.1 (W-B) — the illness/condition journal. Every `/api/illness/*`
  // route gates on the `illness` module via the thin
  // `requireIllnessEnabled(...)` wrapper (which re-stamps the
  // illness-specific errorCode over `requireModuleEnabled("illness")`),
  // recognised below as a delegated gate. Walking the tree means a NEW
  // ungated illness route fails this test BY NAME rather than leaking the
  // surface over a Bearer token when the account turned the module off.
  "src/app/api/illness",
  "src/app/api/gamification",
  // v1.18.1 (D3) — medications graduated from CORE to a toggleable module.
  // It is SURFACE-gated (nav entry, dashboard widget, the dedicated
  // Medikamente settings entry), not data-layer-gated: every `/api/medications/*`
  // route is raw medication CRUD / intake / inventory / compliance over the
  // user's own rows, so they are EXEMPT below under the same data-layer
  // reasoning as mood/labs — disabling the module hides the surface, it does
  // not wedge an importer / sync / the user's ability to clean up, and
  // re-enabling finds the schedule + intake history intact. Walking the tree
  // means a NEW medication route must justify itself (gate or document-exempt)
  // rather than silently appearing.
  "src/app/api/medications",
  // v1.18.0 B3 — the legacy `/api/doctor-report` tree (JSON + server-PDF +
  // availability probe) was orphaned dead code (no production caller) and
  // removed. The doctor-report surface is `/api/export/health-record` plus
  // the FHIR REST face below; both gate on `doctorReport` directly. The FHIR
  // routes previously relied on the removed builder-mention bucket and were
  // in practice ungated — see the header note.
  "src/app/api/fhir",
  // v1.18.0 (B2) — the AI-narrative insights tree. Every status / cards /
  // correlations / derived / narrative / pregenerate / rhythm-events route
  // gates on the `insights` module; the Coach sub-tree delegates to the
  // coach assistant surface; the AI-settings / tile-layout / therapy-timeline
  // infra-and-config routes are EXEMPT below. Walking the tree means a NEW
  // ungated insights AI route fails this test BY NAME rather than leaking the
  // surface over a Bearer token when the account turned insights off.
  "src/app/api/insights",
  // v1.28 — the unified daily-digest read (`GET /api/daily/digest`). The digest
  // is the AI-narrative daily layer, so it gates on the `insights` module via
  // `requireModuleEnabled(user.id, "insights")` directly. Walking the tree means
  // a NEW ungated daily route fails BY NAME rather than leaking over a Bearer
  // token when the account turned insights off.
  "src/app/api/daily",
  // v1.28 — the nutrient-intake sync (opt-in `nutrients` module). Unlike the
  // data-layer-exempt siblings this domain is REFUSE-INGEST-WHEN-OFF (the
  // mental-health posture): both the batch ingest and the window-summary
  // read call `requireModuleEnabled(user.id, "nutrients")` directly, so a
  // phone whose user never opted in cannot land rows server-side. Walking
  // the tree means a NEW ungated nutrients route fails BY NAME.
  "src/app/api/nutrients",
];

/**
 * EXEMPT — routes that serve a toggleable domain but are deliberately
 * ungated. Each carries its reason inline per the bucket-4 contract.
 */
const EXEMPT_ROUTES: ReadonlyArray<string> = [
  // ── DATA LAYER (mood) ─────────────────────────────────────────────
  // Raw MoodEntry CRUD. The module gate governs whether mood SURFACES
  // (nav, dashboard tile, analysis, doctor report), not whether the row
  // store accepts writes. An importer / the moodLog sync / the user's
  // ability to delete or restore entries must keep working while the
  // module is off, and re-enabling must find the rows intact.
  "src/app/api/mood-entries/route.ts",
  "src/app/api/mood-entries/[id]/route.ts",
  "src/app/api/mood-entries/bulk/route.ts",
  "src/app/api/mood-entries/bulk-delete/route.ts",
  "src/app/api/mood-entries/restore/route.ts",
  // Mood tag taxonomy CRUD — the user's tag library + per-tag layout.
  // Pure configuration over the mood vocabulary, not analysis prose;
  // editing the taxonomy while the module is off must not break.
  "src/app/api/mood/tags/route.ts",
  "src/app/api/mood/tags/layout/route.ts",
  "src/app/api/mood/tags/custom/route.ts",
  "src/app/api/mood/tags/custom/[key]/route.ts",
  "src/app/api/mood/tags/groups/route.ts",
  "src/app/api/mood/tags/groups/[key]/route.ts",
  "src/app/api/mood/tags/[key]/hidden/route.ts",
  // ── DATA LAYER (workouts / labs) ──────────────────────────────────
  // The workout READ surfaces (`GET /api/workouts`, `GET /api/workouts/{id}`)
  // are now module-gated — they back the hidden Insights workouts surface, so
  // a disabled account must not read them even over a Bearer token. Only the
  // iOS batch INGEST stays exempt: synced workouts must keep landing in the
  // row store while the surface is hidden, so re-enabling reveals a complete
  // history rather than a gap. LabResult CRUD follows the same data-layer
  // reasoning (the labs module gates the surfaces, not the row store).
  "src/app/api/workouts/batch/route.ts",
  "src/app/api/labs/route.ts",
  "src/app/api/labs/[id]/route.ts",
  // v1.18.1 — the lab-result delete-Undo restore endpoint and the
  // user-scoped Biomarker catalog CRUD share the LabResult data-layer
  // reasoning: the labs module gates the SURFACES (the Labs page), not the
  // row store. A synced / pre-existing reading and its catalog definition
  // must survive a disabled module so re-enabling reveals a complete history.
  "src/app/api/labs/restore/route.ts",
  "src/app/api/biomarkers/route.ts",
  "src/app/api/biomarkers/[id]/route.ts",
  // v1.18.9 — the Lab-OCR ingestion routes share the LabResult data-layer
  // reasoning: the labs module gates the SURFACE (the Labs page + scan
  // affordance), not the row store. The extract route is read-only vision
  // assistance, the commit route writes the user's own confirmed lab rows,
  // and the capability probe is an infra availability check carrying no
  // module data. All three are owner-scoped and AI-gated (consent / budget /
  // rate); the module toggle hiding the surface does not need to wedge them.
  "src/app/api/labs/ocr/capability/route.ts",
  "src/app/api/labs/ocr/extract/route.ts",
  "src/app/api/labs/ocr/commit/route.ts",
  // ── DATA LAYER (medications) ──────────────────────────────────────
  // v1.18.1 (D3) — medications graduated from CORE to a toggleable module,
  // but it is SURFACE-gated (nav / dashboard widget / settings entry), not
  // data-layer-gated. Every `/api/medications/*` route is raw CRUD over the
  // user's own medication / intake / inventory / compliance / side-effect
  // rows — the same data-layer reasoning as mood/labs: the module gate
  // governs whether medications SURFACES, not whether the row store accepts
  // writes. An importer / sync / the user's ability to clean up entries must
  // keep working while the module is off, and re-enabling must find the
  // schedule + intake history intact.
  "src/app/api/medications/route.ts",
  "src/app/api/medications/layout/route.ts",
  "src/app/api/medications/compliance/route.ts",
  "src/app/api/medications/intake/route.ts",
  "src/app/api/medications/intake/bulk/route.ts",
  // NB: `medications/extract` is NOT exempt — it gates on
  // `requireAssistantSurface("coach")` (the NL-extraction is an assistant
  // surface), so the inventory already counts it as a delegated gate.
  "src/app/api/medications/[id]/route.ts",
  "src/app/api/medications/[id]/api-endpoint/route.ts",
  "src/app/api/medications/[id]/cadence/route.ts",
  "src/app/api/medications/[id]/compliance/route.ts",
  "src/app/api/medications/[id]/dose-history/route.ts",
  "src/app/api/medications/[id]/glp1/route.ts",
  "src/app/api/medications/[id]/phase-config/route.ts",
  "src/app/api/medications/[id]/intake/route.ts",
  "src/app/api/medications/[id]/intake/[eventId]/route.ts",
  "src/app/api/medications/[id]/intake/bulk-delete/route.ts",
  "src/app/api/medications/[id]/intake/import/route.ts",
  "src/app/api/medications/[id]/intake/import/[jobId]/status/route.ts",
  "src/app/api/medications/[id]/intake/purge/route.ts",
  "src/app/api/medications/[id]/inventory/route.ts",
  "src/app/api/medications/[id]/inventory/[itemId]/route.ts",
  "src/app/api/medications/[id]/schedule-revisions/route.ts",
  "src/app/api/medications/[id]/schedule-revisions/[revisionId]/route.ts",
  "src/app/api/medications/[id]/side-effects/route.ts",
  "src/app/api/medications/[id]/side-effects/[logId]/route.ts",
  // The efficacy read + user-override target share the medication data-layer
  // reasoning: they compute over the user's own medication + metric/lab rows
  // and persist only a per-user override. The module gate governs the Wirkung
  // SURFACE (the detail-page tab + the insights summary), not the row store.
  "src/app/api/medications/[id]/efficacy/route.ts",
  "src/app/api/medications/[id]/efficacy/target/route.ts",
  // ── INFRA / UI-ONLY ───────────────────────────────────────────────
  // Static FHIR CapabilityStatement — server metadata, no user data.
  "src/app/api/fhir/metadata/route.ts",
  // ── INFRA / CONFIG (insights) ─────────────────────────────────────
  // v1.18.0 (B2) — the insights tree's non-narrative routes. The
  // `insights` module gates the AI-narrative SURFACES (status cards,
  // correlations, derived scores, period narrative, the rhythm-event
  // timeline); these six carry no narrative payload, so gating them would
  // only break configuration / settings reads while the module is off.
  //
  // AI provider + privacy settings and the read-only chain summary — pure
  // configuration of the assistant, surfaced under Settings → AI, not an
  // insights surface. Editing the AI config while insights is off must work
  // (e.g. to set up a provider before re-enabling the module).
  "src/app/api/insights/settings/route.ts",
  "src/app/api/insights/provider-chain/route.ts",
  // Insights tile-order + visibility layout (GET/PUT/DELETE) — the user's
  // own persisted preference blob, the insights peer of
  // `/api/dashboard/widgets`. Pure UI configuration, no module data; the
  // /insights page itself is nav-gated on the module.
  "src/app/api/insights/layout/route.ts",
  // Insight feedback write (👍/👎 on a generated card) — a feedback row,
  // not an insights READ. Harmless while the module is off and never
  // surfaces module data.
  "src/app/api/insights/feedback/route.ts",
  // Target-range reference values (BMI / BP / sleep / steps classifiers +
  // compliance context) — deterministic threshold config consumed across
  // surfaces, not an AI-narrative insights read.
  "src/app/api/insights/targets/route.ts",
  // GLP-1 therapy-timeline aggregator backing the /insights/medications
  // component — a MEDICATIONS-domain data merge (dose / injection /
  // inventory / side-effect events), and medications is a core, always-on
  // domain with no module gate. It is not an insights-module surface.
  "src/app/api/insights/glp1-timeline/route.ts",
  // GLP-1 weight-plateau read backing the plateau note beside the drug-level
  // curve (efficacy tab + /insights/medications) — the same MEDICATIONS-domain
  // rationale as glp1-timeline above: a deterministic detector over weight +
  // dose history, no AI narrative, medications is core/always-on.
  "src/app/api/insights/glp1-plateau/route.ts",
];

const MODULE_GATE_NEEDLE = "requireModuleEnabled(";
const CYCLE_GATE_NEEDLE = "requireCycleEnabled(";
const COACH_GATE_NEEDLE = 'requireAssistantSurface("coach")';
// v1.18.1 — the illness journal's thin gate wrapper. `requireIllnessEnabled`
// delegates to `requireModuleEnabled(userId, "illness")` and re-stamps the
// illness-specific errorCode, exactly mirroring how `cycle` delegates to
// `requireCycleEnabled`. Recognised as a delegated gate so illness routes
// are not flagged as ungated.
const ILLNESS_GATE_NEEDLE = "requireIllnessEnabled(";

/**
 * Trees whose routes must gate on ONE specific module key. Naming the key
 * here means a future route in the tree cannot satisfy the inventory by
 * gating on some other, more permissive module — the failure mode that a
 * generic "is there any gate?" check cannot see.
 *
 * `/api/fhir` is the entry that matters: every data route there serves the
 * whole-record doctor-report aggregate, so `doctorReport` is the only
 * correct key.
 */
const REQUIRED_TREE_MODULE: Readonly<Record<string, ModuleKey>> = {
  "src/app/api/fhir": "doctorReport",
};

/**
 * Surfaces whose module behaviour is proven by a real behavioural test
 * (module off ⇒ 403 or omission; module on ⇒ served). Listed so that
 * deleting the proof fails the inventory instead of quietly downgrading the
 * guarantee back to a text match.
 *
 * The three aggregate surfaces below are the ones that re-served per-domain
 * data ungated: two of them (`/api/sync/changes`, `/api/dashboard/summary`)
 * are cross-domain feeds that live outside `MODULE_ROUTE_TREES` entirely, so
 * without this list nothing in the inventory would notice them at all.
 */
const BEHAVIOURAL_GATE_TESTS: ReadonlyArray<{ path: string; proves: string }> =
  [
    {
      path: "src/app/api/fhir/__tests__/module-gate.test.ts",
      proves:
        "every /api/fhir data route 403s with module.disabled when doctorReport is off",
    },
    {
      path: "src/lib/fhir/__tests__/rest-module-backstop.test.ts",
      proves:
        "loadFhirContext itself refuses to assemble the record when doctorReport is off",
    },
    {
      path: "src/app/api/sync/changes/__tests__/module-gate.test.ts",
      proves:
        "the sync delta feed omits cycleDays/cycles (and never queries them) when cycle is off",
    },
    {
      path: "src/app/api/dashboard/summary/__tests__/module-gate.test.ts",
      proves:
        "the dashboard summary drops disabled-module metric cards while core vitals still ship",
    },
  ];

/**
 * True when the file contains the needle on a line that is NOT a pure
 * comment. A docstring that merely MENTIONS the gate must not satisfy the
 * presence check — otherwise deleting the real call but leaving the
 * comment would slip through.
 */
function fileHasCall(text: string, needle: string): boolean {
  return text.split("\n").some((line) => {
    if (!line.includes(needle)) return false;
    const trimmed = line.trim();
    if (trimmed.startsWith("//")) return false;
    if (trimmed.startsWith("*")) return false;
    return true;
  });
}

/**
 * Extract the module key from a `requireModuleEnabled(user.id, "<key>")`
 * call. Returns the literal key, or null when the key is computed (the
 * parameterised insights routes resolve it from a metric map — those gate
 * dynamically and are accepted as gated without a literal-key assertion).
 */
function extractModuleKeys(text: string): {
  hasLiteral: boolean;
  keys: Set<string>;
} {
  const keys = new Set<string>();
  let hasLiteral = false;
  const re = /requireModuleEnabled\([^,]+,\s*"([a-zA-Z]+)"\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    hasLiteral = true;
    keys.add(m[1]);
  }
  return { hasLiteral, keys };
}

const repoRoot = resolve(__dirname, "..", "..", "..", "..");

/** Walk one route tree, returning POSIX paths relative to the repo root. */
function findRouteFiles(treeRel: string): string[] {
  const root = resolve(repoRoot, treeRel);
  const hits: string[] = [];

  function walk(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        if (entry === "__tests__" || entry === "node_modules") continue;
        walk(full);
        continue;
      }
      if (entry !== "route.ts") continue;
      hits.push(relative(repoRoot, full).split(/[\\/]/).join("/"));
    }
  }

  walk(root);
  return hits;
}

function findAllModuleRouteFiles(): string[] {
  return MODULE_ROUTE_TREES.flatMap(findRouteFiles).sort();
}

describe("module API route gate inventory", () => {
  it("the module registry covers the keys this inventory reasons about", () => {
    // Guard against a registry key being added without the inventory
    // gaining an opinion about its routes. Every gated/delegated key the
    // test pins must be a real ModuleKey.
    const known = new Set<ModuleKey>(MODULE_KEYS);
    for (const key of [
      "mood",
      "sleep",
      "glucose",
      "workouts",
      "recovery",
      "labs",
      "illness",
      "achievements",
      "cycle",
      "coach",
      "doctorReport",
      "insights",
      "medications",
    ] as const) {
      expect(known.has(key), `unknown module key in inventory: ${key}`).toBe(
        true,
      );
    }
  });

  it("every toggleable-module route is gated, delegated, or explicitly exempt", () => {
    const routes = findAllModuleRouteFiles();
    expect(routes.length).toBeGreaterThan(0);

    const exempt = new Set(EXEMPT_ROUTES);
    const orphans: Array<{ path: string; reason: string }> = [];

    for (const path of routes) {
      const text = readFileSync(resolve(repoRoot, path), "utf8");

      if (fileHasCall(text, MODULE_GATE_NEEDLE)) continue;
      if (fileHasCall(text, CYCLE_GATE_NEEDLE)) continue;
      if (fileHasCall(text, COACH_GATE_NEEDLE)) continue;
      if (fileHasCall(text, ILLNESS_GATE_NEEDLE)) continue;

      if (exempt.has(path)) continue;

      orphans.push({
        path,
        reason:
          'no module gate found — add requireModuleEnabled("<key>") or a delegated gate, ' +
          "or move the route onto EXEMPT_ROUTES with a documented reason. " +
          "Importing a module-aware builder is NOT a gate: a builder can filter some " +
          "modules and never evaluate yours.",
      });
    }

    expect(
      orphans,
      [
        "Module API route gate inventory found unaccounted-for handler(s):",
        ...orphans.map((o) => `  - ${o.path}: ${o.reason}`),
      ].join("\n"),
    ).toEqual([]);
  });

  it("directly module-gated routes pin a real module key", () => {
    const routes = findAllModuleRouteFiles();
    const known = new Set<string>(MODULE_KEYS);
    const bad: Array<{ path: string; key: string }> = [];

    for (const path of routes) {
      const text = readFileSync(resolve(repoRoot, path), "utf8");
      if (!fileHasCall(text, MODULE_GATE_NEEDLE)) continue;
      const { keys } = extractModuleKeys(text);
      // Parameterised routes (computed key) carry no literal — accepted.
      for (const key of keys) {
        if (!known.has(key)) bad.push({ path, key });
      }
    }

    expect(
      bad,
      [
        "requireModuleEnabled() called with an unknown module key:",
        ...bad.map((b) => `  - ${b.path}: "${b.key}"`),
      ].join("\n"),
    ).toEqual([]);
  });

  it("routes in a key-pinned tree gate on that tree's module key", () => {
    // A generic "is there any gate?" check cannot tell `doctorReport` from
    // some other, more permissive key. Where a whole tree serves exactly one
    // module, name it.
    const wrong: Array<{ path: string; found: string[] }> = [];

    for (const [tree, requiredKey] of Object.entries(REQUIRED_TREE_MODULE)) {
      for (const path of findRouteFiles(tree)) {
        if (EXEMPT_ROUTES.includes(path)) continue;
        const text = readFileSync(resolve(repoRoot, path), "utf8");
        const { keys } = extractModuleKeys(text);
        if (!keys.has(requiredKey)) {
          wrong.push({ path, found: [...keys] });
        }
      }
    }

    expect(
      wrong,
      [
        "Routes that must gate on their tree's module key but do not:",
        ...wrong.map(
          (w) =>
            `  - ${w.path}: found [${w.found.join(", ") || "no literal key"}]`,
        ),
      ].join("\n"),
    ).toEqual([]);
  });

  it("the behavioural gate tests that prove refusal still exist", () => {
    // This inventory only reads source text. The listed files are what
    // actually exercise a disabled module end to end; losing one silently
    // downgrades the guarantee back to a text match, which is precisely the
    // failure this test was rewritten to prevent.
    const missing = BEHAVIOURAL_GATE_TESTS.filter(
      (t) => !existsSync(resolve(repoRoot, t.path)),
    );

    expect(
      missing,
      [
        "Behavioural module-gate coverage has gone missing.",
        "This inventory cannot prove a gate refuses — these tests do:",
        ...missing.map((m) => `  - ${m.path}\n      proves: ${m.proves}`),
        "Restore the file, or drop the entry and say what replaces it.",
      ].join("\n"),
    ).toEqual([]);
  });

  it("EXEMPT_ROUTES does not reference deleted route files", () => {
    const known = new Set(findAllModuleRouteFiles());
    const stale = EXEMPT_ROUTES.filter((p) => !known.has(p));

    expect(
      stale,
      [
        "EXEMPT_ROUTES points to files that no longer exist —",
        "delete the stale entries from",
        "`src/app/api/__tests__/module-route-gate-inventory.test.ts`:",
        ...stale.map((p) => `  - ${p}`),
      ].join("\n"),
    ).toEqual([]);
  });

  it("EXEMPT_ROUTES does not hide a route that actually carries a gate", () => {
    // A route that gained a real gate should be removed from the exempt
    // list so the list stays an honest record of the ungated surfaces.
    const stillGated: string[] = [];
    for (const path of EXEMPT_ROUTES) {
      const text = readFileSync(resolve(repoRoot, path), "utf8");
      if (
        fileHasCall(text, MODULE_GATE_NEEDLE) ||
        fileHasCall(text, CYCLE_GATE_NEEDLE) ||
        fileHasCall(text, COACH_GATE_NEEDLE) ||
        fileHasCall(text, ILLNESS_GATE_NEEDLE)
      ) {
        stillGated.push(path);
      }
    }

    expect(
      stillGated,
      [
        "These EXEMPT_ROUTES now carry a gate — drop them from the exempt list:",
        ...stillGated.map((p) => `  - ${p}`),
      ].join("\n"),
    ).toEqual([]);
  });
});
