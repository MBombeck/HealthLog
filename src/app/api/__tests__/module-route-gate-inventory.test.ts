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
 *        - an AI capability → `requireAiCapability(key)` /
 *                   `getAiCapability(key)`. A capability resolves its owning
 *                   modules and the AI opt-out (the `coach` module and
 *                   `disableCoach` for the Coach, the `insights` module for
 *                   every other capability), so an AI route that names one is
 *                   gated on those modules. Covered in depth by
 *                   `ai-capability-route-inventory.test.ts`. The `insights`
 *                   module is the AI analysis opt-out and gates only AI parts;
 *                   the data routes that happen to live under
 *                   `/api/insights` are EXEMPT below.
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
 *
 * WHICH TREES GET WALKED, AND WHY THAT IS NOT A HAND-WRITTEN LIST ANY MORE
 * -----------------------------------------------------------------------
 * A discovery test is only worth what its discovery covers, and this one used
 * to enumerate its trees in a flat array that grew when somebody remembered to
 * grow it. It had stopped: `coach`, `environment`, `mentalHealth`,
 * `inboundDocuments` and `mcp` each shipped an API tree that this file never
 * looked at. No leak came of it — every route in the first four gates — but
 * that was the authors' care and not this test's, and a green run was saying
 * something narrower than it appeared to say.
 *
 * The trees are now declared per module key as an exhaustive
 * `Record<ModuleKey, …>`, so the REGISTRY drives coverage: a new key does not
 * compile without an entry, and an API directory named after a key is
 * discovered from the filesystem and must be declared for it. A tree at a
 * non-obvious address (`achievements` → `/api/gamification`) still has to be
 * named by hand — that is the residual gap, and it is the reason the
 * declaration carries a comment per key rather than a bare path.
 */

/**
 * The per-domain API route trees each toggleable module owns, keyed by the
 * registry key.
 *
 * Declared as an exhaustive `Record<ModuleKey, …>` so the REGISTRY drives
 * coverage rather than anybody's memory: adding a key to `MODULE_KEYS` without
 * deciding which API tree it owns does not compile, and the two tests below
 * catch the same omission at runtime — one asserting every registry key is
 * declared, one asserting that an API directory NAMED after a module key is
 * declared for that key.
 *
 * The hand-written array this replaced could only grow when a contributor
 * remembered to grow it, and it had stopped growing: `coach`, `environment`,
 * `mentalHealth`, `inboundDocuments` and `mcp` all shipped an API tree that
 * this inventory never walked. Every route in the first four turned out to be
 * gated, so nothing leaked — but that was the authors' care, not this file's
 * doing, and the next tree would have been just as invisible.
 *
 * An empty array is a claim, not a gap: the module owns no API tree of its
 * own, and the entry says where its data actually lives.
 *
 * A domain owned entirely by one builder (doctor-report / FHIR) or one
 * delegated gate (cycle) is still walked, so a NEW route in the tree must
 * justify itself.
 */
const MODULE_ROUTE_TREES_BY_KEY: Readonly<
  Record<ModuleKey, readonly string[]>
> = {
  cycle: ["src/app/api/cycle"],
  mood: ["src/app/api/mood", "src/app/api/mood-entries"],
  sleep: ["src/app/api/sleep"],
  // Glucose has no tree of its own: readings are Measurement rows on the core
  // measurement engine, and the glucose panel is an insights surface. The
  // module gates the surfaces, which live under trees already walked here.
  glucose: [],
  workouts: ["src/app/api/workouts"],
  // Recovery, like glucose, rides the measurement engine — no dedicated tree.
  recovery: [],
  // v1.18.1 — the user-scoped Biomarker catalog backs the Labs feature.
  labs: ["src/app/api/labs", "src/app/api/biomarkers"],
  // v1.18.1 (W-B) — the illness/condition journal. Every `/api/illness/*`
  // route gates on the `illness` module via the thin
  // `requireIllnessEnabled(...)` wrapper (which re-stamps the
  // illness-specific errorCode over `requireModuleEnabled("illness")`),
  // recognised below as a delegated gate.
  illness: ["src/app/api/illness"],
  achievements: ["src/app/api/gamification"],
  // The Coach tree. Every route calls `requireModuleEnabled(userId, "coach")`
  // directly, which resolves the delegated two-layer state (assistant master
  // flag AND the per-user opt-out) through the registry — so the routes are
  // counted as directly gated here, and the sibling
  // `coach-route-gate-inventory.test.ts` covers the surface in depth.
  coach: ["src/app/api/coach"],
  // The `insights` module is the AI analysis opt-out. It owns no data route:
  // the AI routes under these trees name a capability that folds it in, and
  // the data routes that live here (ECG, scores, statistics, the Today
  // digest) are EXEMPT below because a computation never depends on AI.
  insights: ["src/app/api/insights", "src/app/api/daily"],
  // v1.18.1 (D3) — medications graduated from CORE to a toggleable module.
  // SURFACE-gated (nav entry, dashboard widget, the dedicated Medikamente
  // settings entry), not data-layer-gated: every `/api/medications/*` route is
  // raw CRUD / intake / inventory / compliance over the user's own rows, so
  // they are EXEMPT below under the same data-layer reasoning as mood/labs.
  medications: ["src/app/api/medications"],
  // v1.18.0 B3 — the legacy `/api/doctor-report` tree was orphaned dead code
  // and removed. The doctor-report surface is `/api/export/health-record` plus
  // the FHIR REST face; both gate on `doctorReport` directly, and both are
  // key-pinned below so a future route cannot satisfy the inventory by gating
  // on some other, more permissive module.
  doctorReport: ["src/app/api/fhir", "src/app/api/export/health-record"],
  // v1.25.0 (W-ENV) — the environmental-context tree. Every route calls
  // `requireModuleEnabled(user.id, "environment")`, including the geocode
  // lookup and the backfill, because each one either reads the module's data
  // or spends the outbound weather/geocode budget on the user's behalf.
  environment: ["src/app/api/environment"],
  // v1.22.0 — the remote MCP endpoint is `src/app/mcp/route.ts`, OUTSIDE the
  // `/api` tree, and it gates on the module itself. What lives under
  // `/api/mcp` is the credential-management surface behind it, exempt below.
  mcp: ["src/app/api/mcp"],
  // v1.25.0 (W-DOCS-IN) — the inbound clinical-document vault. Every route
  // gates on `inboundDocuments`; the AI READ of a document is a separate
  // per-user opt-in on top.
  inboundDocuments: ["src/app/api/documents/inbound"],
  // v1.25.0 — the mental-health screeners. Both routes gate on `mentalHealth`.
  mentalHealth: ["src/app/api/mental-health"],
  // v1.28 — the nutrient-intake sync (opt-in module). Unlike the
  // data-layer-exempt siblings this domain is REFUSE-INGEST-WHEN-OFF (the
  // mental-health posture): both the batch ingest and the window-summary read
  // gate directly, so a phone whose user never opted in cannot land rows.
  nutrients: ["src/app/api/nutrients"],
  // v1.38.0 — the immunization log. SURFACE-gated like medications, not
  // data-layer-gated: every `/api/vaccinations/*` route is raw CRUD over the
  // person's own doses, so all six are EXEMPT below under the same reasoning.
  vaccinations: ["src/app/api/vaccinations"],
};

/** Every declared tree, de-duplicated — the set this inventory walks. */
const MODULE_ROUTE_TREES: ReadonlyArray<string> = [
  ...new Set(Object.values(MODULE_ROUTE_TREES_BY_KEY).flat()),
].sort();

/**
 * EXEMPT — routes that serve a toggleable domain but are deliberately
 * ungated. Each carries its reason inline per the bucket-4 contract.
 */
const EXEMPT_ROUTES: ReadonlyArray<string> = [
  // ── DATA LAYER (mood) ─────────────────────────────────────────────
  // Raw MoodEntry CRUD. The module gate governs whether mood SURFACES
  // (nav, dashboard tile, analysis, doctor report), not whether the row
  // store accepts writes. An importer / the user's
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
  // module data. The extract route is not listed: it names the `labsOcr` AI
  // capability, which carries the labs module, so it counts as gated.
  "src/app/api/labs/ocr/capability/route.ts",
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
  // v1.40 (#1041) — the person's own category vocabulary: the same row
  // store, the same data-layer reasoning.
  "src/app/api/medications/categories/route.ts",
  "src/app/api/medications/categories/[key]/route.ts",
  // v1.40 (#1024) — a medication's courses, same again.
  "src/app/api/medications/[id]/courses/route.ts",
  "src/app/api/medications/[id]/courses/[courseId]/route.ts",
  "src/app/api/medications/compliance/route.ts",
  "src/app/api/medications/intake/route.ts",
  "src/app/api/medications/intake/bulk/route.ts",
  // The account-wide dose-history import is the same class as the
  // per-medication importer below: it writes intake rows and reads its own job.
  "src/app/api/medications/intake/dose-history-import/route.ts",
  "src/app/api/medications/intake/dose-history-import/[jobId]/status/route.ts",
  // `medications/extract` is not listed: it is model work under the
  // `medicationExtract` AI capability (no owning module; medications is a
  // core domain for extraction), and a capability call counts as the gate.
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
  // ── DATA (insights tree) ──────────────────────────────────────────
  // The `insights` module is the AI analysis opt-out, so it gates AI parts
  // only, through the capability. These routes serve or accept data that no
  // model wrote: device recordings and events, computed scores, statistics,
  // rule alerts, the person's stored Coach data and the Today digest. Turning
  // AI analysis off must leave every one of them working.
  "src/app/api/insights/ecg/route.ts",
  "src/app/api/insights/ecg/[id]/route.ts",
  "src/app/api/insights/rhythm-events/route.ts",
  "src/app/api/insights/derived/batch/route.ts",
  "src/app/api/insights/cards/route.ts",
  "src/app/api/insights/correlations/route.ts",
  "src/app/api/insights/coach-read/route.ts",
  "src/app/api/insights/health-status/route.ts",
  "src/app/api/insights/pulse/intraday/route.ts",
  "src/app/api/insights/patterns/route.ts",
  "src/app/api/insights/patterns/[id]/route.ts",
  // Stored Coach data: viewing and erasing it never depends on the Coach
  // being available (the GDPR reason), and a timestamp on one's own row is
  // data too.
  "src/app/api/insights/coach/seen/route.ts",
  // `insights/coach/facts/route.ts` is not listed, by the rule below: it
  // lists and erases without the Coach gate but keeps it on POST (the
  // remember button saves to the Coach's memory, which is Coach use).
  "src/app/api/insights/coach/facts/[id]/route.ts",
  // The stored plans list. Its sibling `[id]` route keeps the Coach gate on
  // PATCH (confirming a proposal is Coach use) and erases without it.
  "src/app/api/coach/plans/route.ts",
  // Not listed, by the same rule: `coach/reminders/route.ts` lists without the
  // Coach gate but keeps it on POST (creating one is Coach use), and
  // `coach/reminders/[id]/route.ts` erases without it but keeps it on PATCH.
  // Both files still carry a gate, so the walk counts them as gated and an
  // entry here would fail the "does not hide a gate" check below.
  "src/app/api/insights/chat/[id]/route.ts",
  "src/app/api/insights/chat/messages/[id]/feedback/route.ts",
  // One message's stored tables. No whole-route gate for the same reason,
  // but each table is withheld when the module owning its domain is off
  // (`isCoachDomainWithheld` over the resolved module map), so a switched-off
  // domain's values never come back through a stored answer.
  "src/app/api/insights/chat/[id]/messages/[messageId]/results/route.ts",
  // The Today digest and its dismiss: data, with the AI parts masked by the
  // loader through the capability resolver.
  "src/app/api/daily/digest/route.ts",
  "src/app/api/daily/digest/dismiss/route.ts",
  // ── INFRA / CONFIG (insights) ─────────────────────────────────────
  // The insights tree's configuration routes carry no narrative payload,
  // so gating them would only break configuration / settings reads while
  // the module is off.
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
  // ── DATA LAYER (vaccinations) ─────────────────────────────────────
  // v1.38.0 — the immunization log is SURFACE-gated (nav entry, dashboard
  // and report leaves, the picker), not data-layer-gated. Every
  // `/api/vaccinations/*` route is raw CRUD over the person's own doses and
  // the pages they were transcribed from — the same reasoning as mood, labs
  // and medications above: the module toggle governs whether vaccinations
  // SURFACE, not whether the row store accepts rows. A restore or an import
  // must keep working while the module is off, and re-enabling must find
  // every dose intact rather than a gap in an Impfpass nobody can rebuild.
  "src/app/api/vaccinations/route.ts",
  "src/app/api/vaccinations/[id]/route.ts",
  "src/app/api/vaccinations/[id]/restore/route.ts",
  "src/app/api/vaccinations/[id]/links/route.ts",
  // v1.42 (#1005) — the record's own vaccine definitions. Same posture: a
  // restore must bring back the definitions its doses point at with the
  // surface hidden.
  "src/app/api/vaccinations/custom/route.ts",
  "src/app/api/vaccinations/custom/[id]/route.ts",
  // The booster mint and the upload suggestion are the same posture: a restore
  // or an import that arms a booster, or a document review that files a scan,
  // must keep working with the surface hidden, so the data routes stay exempt
  // while the nav entry, the picker and the report leaf hide.
  "src/app/api/vaccinations/[id]/booster/route.ts",
  "src/app/api/vaccinations/suggest/route.ts",
  // ── INFRA / CREDENTIALS (mcp) ─────────────────────────────────────
  // The remote MCP endpoint itself is `src/app/mcp/route.ts`, outside `/api`,
  // and it carries the gate: an account with the module off gets a 404 there
  // regardless of the credential presented (proven by the behavioural test
  // listed below). What lives under `/api/mcp` is the credential surface
  // BEHIND that endpoint, and it is deliberately not gated:
  //
  //   - the token list / mint / revoke and the connection rows are the
  //     cookie-session settings card. Revoking must keep working while the
  //     module is off — that is precisely when somebody wants to revoke — and
  //     minting happens in the same breath as switching the module on.
  //   - the OAuth bridge mints and exchanges the same `health:read`
  //     credential for a cloud connector. It runs on `withBackgroundEvent`
  //     with its protections applied by hand (rate limit, body cap, kill
  //     switch, mandatory PKCE-S256, redirect-URI allowlist) per the
  //     documented exception, and the credential it issues is inert while the
  //     module is off because `/mcp` refuses it.
  //
  // Gating these would not close a data path; it would only wedge the surface
  // that turns the module on and off.
  "src/app/api/mcp/tokens/route.ts",
  "src/app/api/mcp/tokens/[id]/route.ts",
  "src/app/api/mcp/connections/route.ts",
  "src/app/api/mcp/connections/[id]/route.ts",
  "src/app/api/mcp/oauth/authorize/route.ts",
  "src/app/api/mcp/oauth/token/route.ts",
  "src/app/api/mcp/oauth/register/route.ts",
];

const MODULE_GATE_NEEDLE = "requireModuleEnabled(";
const CYCLE_GATE_NEEDLE = "requireCycleEnabled(";
// An AI capability resolves its owning modules and the AI opt-out, so a route
// that names one is gated on them.
const AI_CAPABILITY_GATE =
  /\b(?:requireAiCapability|getAiCapability|aiCapabilityToServe)\s*\(/;
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
  "src/app/api/export/health-record": "doctorReport",
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
    {
      // The `mcp` module's enforcement point is outside `/api` entirely, so
      // nothing in the tree walk above can see it. Listing the proof here is
      // what keeps it from disappearing unnoticed.
      path: "src/app/mcp/__tests__/route.test.ts",
      proves:
        "the remote MCP endpoint 404s when the mcp module is off, which is what makes the ungated /api/mcp credential surface safe",
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

/** True when a non-comment line calls an AI capability gate. */
function fileHasCapabilityGate(text: string): boolean {
  return text.split("\n").some((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) return false;
    return AI_CAPABILITY_GATE.test(line);
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
      "environment",
      "mentalHealth",
      "inboundDocuments",
      "nutrients",
      "mcp",
      "vaccinations",
    ] as const) {
      expect(known.has(key), `unknown module key in inventory: ${key}`).toBe(
        true,
      );
    }
  });

  it("every module key declares which API trees it owns", () => {
    // The type already makes an omission a compile error. This is the runtime
    // half: it fails by NAME, so the message says which key was added without
    // anybody deciding where its routes live.
    const undeclared = MODULE_KEYS.filter(
      (key) => !(key in MODULE_ROUTE_TREES_BY_KEY),
    );

    expect(
      undeclared,
      [
        "Module keys with no entry in MODULE_ROUTE_TREES_BY_KEY:",
        ...undeclared.map((k) => `  - ${k}`),
        "Name the module's API tree(s), or declare [] and say in the comment",
        "where its data actually lives.",
      ].join("\n"),
    ).toEqual([]);
  });

  it("every declared route tree exists on disk", () => {
    const missing = Object.entries(MODULE_ROUTE_TREES_BY_KEY).flatMap(
      ([key, trees]) =>
        trees
          .filter((tree) => !existsSync(resolve(repoRoot, tree)))
          .map((tree) => `  - ${key}: ${tree}`),
    );

    expect(
      missing,
      [
        "MODULE_ROUTE_TREES_BY_KEY names directories that do not exist —",
        "a renamed or deleted tree silently stops being walked:",
        ...missing,
      ].join("\n"),
    ).toEqual([]);
  });

  it("an API directory named after a module key is declared for that key", () => {
    // This is the check the hand-written array could not perform. A module
    // whose routes live at the obvious address (`/api/environment` for
    // `environment`, `/api/mental-health` for `mentalHealth`) is discovered
    // from the filesystem, so a tree cannot sit outside the inventory just
    // because nobody added a line here. Trees at a NON-obvious address
    // (`achievements` → `/api/gamification`, `inboundDocuments` →
    // `/api/documents/inbound`) still have to be declared by hand; the
    // declaration is what this test compares against.
    const apiRoot = resolve(repoRoot, "src/app/api");
    const undeclared: string[] = [];

    for (const key of MODULE_KEYS) {
      const dirName = key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
      const tree = `src/app/api/${dirName}`;
      if (!existsSync(join(apiRoot, dirName))) continue;
      if (MODULE_ROUTE_TREES_BY_KEY[key].includes(tree)) continue;
      undeclared.push(`  - ${key}: ${tree} exists but is not declared`);
    }

    expect(
      undeclared,
      [
        "API trees named after a module key that this inventory does not walk:",
        ...undeclared,
        "Declare the tree under its key in MODULE_ROUTE_TREES_BY_KEY. Every",
        "route beneath it then has to be gated, delegated, or exempt with a",
        "documented reason.",
      ].join("\n"),
    ).toEqual([]);
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
      if (fileHasCall(text, ILLNESS_GATE_NEEDLE)) continue;
      if (fileHasCapabilityGate(text)) continue;

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
        fileHasCall(text, ILLNESS_GATE_NEEDLE) ||
        fileHasCapabilityGate(text)
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
