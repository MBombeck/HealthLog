/**
 * v1.18.0 — canonical module registry.
 *
 * The single source of truth for "what is a module" in HealthLog's
 * enable/disable foundation. Every leak-point (nav, dashboard tiles,
 * insights sections, coach snapshot, status routes, reminder jobs,
 * achievements, doctor-report / FHIR, search, quick-add) reads its gate
 * decision through `src/lib/modules/gate.ts`, which keys off the entries
 * declared here.
 *
 * Two classes of domain:
 *
 *   - CORE (always-on): weight, blood pressure, pulse — the measurement
 *     engine. These are NOT in `MODULE_KEYS` and have NO registry entry.
 *     They can never be disabled; the gate has no key to flip and the
 *     write endpoint refuses them. This is structural, not a runtime check
 *     future code can soften. (Medications was CORE through v1.18.0; D3
 *     graduated it to a fail-open toggleable module below.)
 *
 *   - TOGGLEABLE (the "secondary domains"): the maintainer-chosen scope
 *     below. Each carries a stable key, an i18n label + description key,
 *     a category for the Settings hub grouping, and an optional
 *     `delegatesTo` marker for the two modules whose enabled-state is
 *     owned elsewhere (no double source of truth).
 *
 * The persisted shape (`User.modulePreferencesJson`) is a DISABLED
 * allowlist: absent / empty / `true` ⇒ enabled, an explicit `false` ⇒
 * disabled. Default-on, no backfill.
 */

/**
 * Where a module's enabled-state is resolved when it is NOT owned by
 * `modulePreferencesJson` directly. Keeps a single source of truth:
 *
 *   - "cycle"  → `isCycleEnabled(gender, CycleProfile)` (the existing
 *                cycle gate; `modulePreferencesJson.cycle` is ignored).
 *   - "coach"  → `User.disableCoach` AND the operator-level assistant
 *                master flag (`getAssistantFlags().coach`); again the
 *                module blob is ignored for this key.
 *
 * Every other toggleable module has no `delegatesTo` and resolves purely
 * from `modulePreferencesJson`.
 */
export type ModuleDelegation = "cycle" | "coach";

/** Coarse grouping for the Settings "What you track" hub. */
export type ModuleCategory =
  | "tracking" // user-logged domains (mood, cycle, glucose, labs)
  | "device" // device / passive-sync domains (sleep, workouts, recovery)
  | "engagement" // gamification (achievements)
  | "intelligence" // AI-driven surfaces (coach, insights)
  | "export" // outbound reporting (doctor report / FHIR)
  | "integration"; // external connectivity (the remote MCP endpoint)

export interface ModuleDefinition {
  /** Stable key — the literal used in `modulePreferencesJson` + the API. */
  key: ModuleKey;
  /** i18n key for the human-readable module name (messages/*.json). */
  labelKey: string;
  /** i18n key for the one-line "what turning this off does" explainer. */
  descriptionKey: string;
  /** Settings-hub grouping. */
  category: ModuleCategory;
  /**
   * When set, the module's enabled-state is NOT resolved from
   * `modulePreferencesJson` — the gate delegates to the named source so
   * there is exactly one source of truth. See `ModuleDelegation`.
   */
  delegatesTo?: ModuleDelegation;
  /**
   * Inverts the per-user default for this key. Ordinary toggleable modules
   * are a DISABLED allowlist (default-on; only an explicit `false` turns
   * them off). An `optIn` module is the opposite: OFF until the user
   * records an explicit `true`. Used for surfaces that expose a new
   * external attack surface and must ship dark — the remote MCP endpoint
   * (ADR-007 / REQ-OPS-1). The operator-availability layer still applies
   * (an operator can disable it server-wide); this flag only flips the
   * per-user default.
   */
  optIn?: boolean;
  /**
   * For delegated modules only: where the canonical settings surface lives.
   * The Modules hub renders a LIVE switch for these keys (driving the real
   * column — coach → `User.disableCoach`, cycle → `cycleTrackingEnabled`) and
   * keeps this as a small "manage" deep-link beside the switch, because that
   * surface carries more than on/off (Coach cadence/memory; cycle
   * goal/predictions/lengths). `href` is the in-app link; `labelKey` names the
   * destination ("Account", "Coach settings").
   */
  managedAt?: { href: string; labelKey: string };
}

/**
 * The toggleable modules — the maintainer's "secondary domains" scope.
 *
 * Declared as a const tuple so `ModuleKey` is the exact union and the
 * registry stays exhaustively typed.
 */
export const MODULE_KEYS = [
  "cycle",
  "mood",
  "sleep",
  "glucose",
  "workouts",
  "recovery",
  "labs",
  "illness",
  "achievements",
  "coach",
  "insights",
  // v1.18.1 (D3) — medications graduated from the always-on CORE set to a
  // toggleable module. Weight / blood pressure / pulse stay CORE (the
  // measurement engine is never disableable); medications is now an opt-out
  // domain so an account that does not track meds can hide the surface.
  // SURFACE-gated (nav entry, dashboard medication widget, the dedicated
  // Medikamente settings entry) — the medication data-layer routes stay
  // exempt like mood/labs so an importer / sync / cleanup keeps working and
  // re-enabling finds the rows intact.
  "medications",
  "doctorReport",
  // v1.25.0 (W-ENV) — environmental-context module. Default-on since v1.29.1
  // (a fresh install is usable without a per-module opt-in); the outbound
  // weather fetch only runs once the user configures a home / travel location
  // on the Environment settings surface, so default-on carries no silent
  // egress. No `optIn` marker → the ordinary default-on disabled-allowlist.
  "environment",
  // v1.22.0 — the remote Model Context Protocol endpoint (`/mcp`). Unlike
  // every other module this is OPT-IN (off by default): it exposes a new
  // external-assistant attack surface, so it ships dark and the operator /
  // user turns it on deliberately (ADR-007 / REQ-OPS-1). The `optIn` marker
  // on its registry entry inverts the per-user default; everything else
  // (operator-availability layer, PATCH plumbing, the Modules hub toggle)
  // reuses the existing module machinery unchanged.
  "mcp",
  // v1.25.0 (W-DOCS-IN) — inbound clinical documents (`/documents/inbound`).
  // Default-on since v1.29.1: a fresh install can store + organise documents
  // in the vault out of the box. The AI READ of a document (the egress to the
  // OCR/vision provider) stays a SEPARATE per-user opt-in
  // (`documentsAutoAiRead`), so the module being on never egresses on its own.
  // No `optIn` marker → the ordinary default-on disabled-allowlist.
  "inboundDocuments",
  // v1.25.0 — mental-health screeners (WHO-5 / PHQ-9 / GAD-7), beside mood
  // tracking. Default-on since v1.29.1: the `/mental-wellbeing` check-in is
  // available on a fresh install alongside mood. Item answers are always
  // encrypted and always excluded from the AI Coach / MCP regardless of this
  // toggle. No `optIn` marker → the ordinary default-on disabled-allowlist.
  "mentalHealth",
  // v1.28 — micronutrient-intake sync (vitamins, minerals, water,
  // caffeine as day totals from Apple Health). OPT-IN (off by default):
  // the HealthKit read permission is consent to read on the DEVICE, not
  // visible consent to "a server — and later an AI assistant — holds my
  // supplement pattern"; the project already answered this for less
  // sensitive data (`environment`, weather, is opt-in). With it off the
  // ingest route refuses (403 `module.disabled`) and the settings card
  // does not render. The `optIn` marker inverts the per-user default.
  "nutrients",
  // v1.38.0 — the immunization log (`/vaccinations`). A tracked clinical
  // vertical a person may not use at all, which is exactly the shape the
  // existing opt-out verticals have (`labs`, `illness`, `medications`), so it
  // gets a key rather than riding somebody else's. Default-on, no `optIn`
  // marker: no egress, no new attack surface — the `mentalHealth` /
  // `inboundDocuments` posture.
  //
  // SURFACE-gated like `medications`: the nav entry, the dashboard and report
  // surfaces and the picker hide, and the `/api/vaccinations*` data routes
  // stay exempt so a restore / import keeps working and re-enabling finds
  // every row intact.
  //
  // The one subtlety, stated so nobody reads it as a leak: a booster reminder
  // the user CONFIRMED does not follow this off-switch. It is an ordinary
  // preventive-care row on an engine that is never gated, and a reminder
  // somebody agreed to keeps its promise. Turning the module off hides
  // surfaces the person made content for; it does not silently retract a
  // commitment the app made to them.
  "vaccinations",
] as const;

export type ModuleKey = (typeof MODULE_KEYS)[number];

/**
 * CORE domains — the always-on measurement engine (weight / blood pressure
 * / pulse). Listed here for documentation + the write-endpoint denylist;
 * they have NO `ModuleDefinition` and can never appear as a toggle. A
 * crafted `{ "weight": false }` blob is inert: `weight` is not a
 * `ModuleKey`, so the gate never reads it and the PATCH validator rejects
 * it. (Medications is a toggleable module since D3 — see `MODULE_KEYS`.)
 */
export const CORE_DOMAIN_KEYS = ["weight", "bloodPressure", "pulse"] as const;

export type CoreDomainKey = (typeof CORE_DOMAIN_KEYS)[number];

const CORE_DOMAIN_SET: ReadonlySet<string> = new Set(CORE_DOMAIN_KEYS);

/** True for the four always-on core domains (never disableable). */
export function isCoreDomain(key: string): key is CoreDomainKey {
  return CORE_DOMAIN_SET.has(key);
}

/**
 * The registry. Order is the Settings-hub display order (grouped by
 * category in the UI; this flat order is the canonical iteration order).
 *
 * `insights` decision (documented): disabling `insights` hides only the
 * AI-ANALYSIS surfaces — the Daily Briefing, the per-metric AI status
 * cards, the correlation narration, the Health-Score explainer. It does
 * NOT hide the raw weight / BP / pulse charts or any measurement data:
 * those are core and render from live measurements regardless. `insights`
 * is the narrative layer, not the data layer. (The operator-level
 * assistant master flag is a separate, server-wide kill-switch; this
 * per-user toggle sits below it.)
 *
 * `coach` is the per-user opt-out half of the existing two-layer model
 * (`User.disableCoach` AND the operator master flag). It is surfaced here
 * so the Modules hub lists it alongside its siblings, but it delegates —
 * the module blob never owns it.
 */
export const MODULE_REGISTRY: Readonly<Record<ModuleKey, ModuleDefinition>> =
  Object.freeze({
    cycle: {
      key: "cycle",
      labelKey: "modules.cycle.label",
      descriptionKey: "modules.cycle.description",
      category: "tracking",
      delegatesTo: "cycle",
      // No `managedAt`. The switch here drives `cycleTrackingEnabled`, and
      // that is the whole of the decision; the goal, predictions and cycle
      // lengths live on the /cycle page itself, not in Settings.
    },
    mood: {
      key: "mood",
      labelKey: "modules.mood.label",
      descriptionKey: "modules.mood.description",
      category: "tracking",
    },
    glucose: {
      key: "glucose",
      labelKey: "modules.glucose.label",
      descriptionKey: "modules.glucose.description",
      category: "tracking",
    },
    labs: {
      key: "labs",
      labelKey: "modules.labs.label",
      descriptionKey: "modules.labs.description",
      category: "tracking",
    },
    illness: {
      key: "illness",
      labelKey: "modules.illness.label",
      descriptionKey: "modules.illness.description",
      category: "tracking",
    },
    sleep: {
      key: "sleep",
      labelKey: "modules.sleep.label",
      descriptionKey: "modules.sleep.description",
      category: "device",
    },
    workouts: {
      key: "workouts",
      labelKey: "modules.workouts.label",
      descriptionKey: "modules.workouts.description",
      category: "device",
    },
    recovery: {
      key: "recovery",
      labelKey: "modules.recovery.label",
      descriptionKey: "modules.recovery.description",
      category: "device",
    },
    achievements: {
      key: "achievements",
      labelKey: "modules.achievements.label",
      descriptionKey: "modules.achievements.description",
      category: "engagement",
    },
    coach: {
      key: "coach",
      labelKey: "modules.coach.label",
      descriptionKey: "modules.coach.description",
      category: "intelligence",
      delegatesTo: "coach",
      // The hub switch drives `User.disableCoach`; the dedicated Coach settings
      // section carries the rest (cadence, memory, activation copy).
      managedAt: {
        href: "/settings/coach",
        labelKey: "settings.sections.coach.title",
      },
    },
    insights: {
      key: "insights",
      labelKey: "modules.insights.label",
      descriptionKey: "modules.insights.description",
      category: "intelligence",
    },
    medications: {
      key: "medications",
      labelKey: "modules.medications.label",
      descriptionKey: "modules.medications.description",
      category: "tracking",
    },
    doctorReport: {
      key: "doctorReport",
      labelKey: "modules.doctorReport.label",
      descriptionKey: "modules.doctorReport.description",
      category: "export",
    },
    environment: {
      key: "environment",
      labelKey: "modules.environment.label",
      descriptionKey: "modules.environment.description",
      category: "device",
      // Default-on tracking module (v1.29.1): a fresh install ships the
      // environmental-context surface usable without a separate opt-in. No
      // egress happens until the user configures a home location on the
      // dedicated Environment settings surface, so default-on carries no
      // silent outbound fetch. The MCP endpoint + the auto-AI-read of
      // documents stay opt-in — those are the surfaces that open an egress /
      // attack channel the moment they are on.
    },
    mcp: {
      key: "mcp",
      labelKey: "modules.mcp.label",
      descriptionKey: "modules.mcp.description",
      category: "integration",
      // Off by default: exposes a remote external-assistant surface, so it
      // must be turned on deliberately (ADR-007 / REQ-OPS-1).
      optIn: true,
    },
    inboundDocuments: {
      key: "inboundDocuments",
      labelKey: "modules.inboundDocuments.label",
      descriptionKey: "modules.inboundDocuments.description",
      category: "tracking",
      // Default-on tracking module (v1.29.1): a fresh install can store and
      // organise clinical documents in the vault out of the box. The AI READ
      // of a document (the egress to the OCR/vision provider) is a SEPARATE
      // per-user opt-in (`documentsAutoAiRead`), so the module being on never
      // sends a document anywhere on its own.
    },
    mentalHealth: {
      key: "mentalHealth",
      labelKey: "modules.mentalHealth.label",
      descriptionKey: "modules.mentalHealth.description",
      category: "tracking",
      // Default-on tracking module (v1.29.1): the `/mental-wellbeing` check-in
      // (WHO-5 / PHQ-9 / GAD-7) is available on a fresh install alongside mood.
      // Item answers stay encrypted at rest and remain excluded from the AI
      // Coach / MCP regardless of this toggle — the screener total may ride the
      // doctor-report export the user assembles.
    },
    nutrients: {
      key: "nutrients",
      labelKey: "modules.nutrients.label",
      descriptionKey: "modules.nutrients.description",
      category: "device",
      // Off by default: supplement-pattern intake synced from the phone's
      // health store is server/AI-consent-sensitive even though the
      // HealthKit read permission was granted on the device. Ships dark;
      // ingest refuses while off (refuse-ingest posture, not surface-only).
      optIn: true,
    },
    vaccinations: {
      key: "vaccinations",
      labelKey: "modules.vaccinations.label",
      descriptionKey: "modules.vaccinations.description",
      category: "tracking",
      // No `optIn`: default-on. Nothing leaves the instance and the surfaces
      // are inert until the person logs a dose.
    },
  });

const MODULE_KEY_SET: ReadonlySet<string> = new Set(MODULE_KEYS);

/** True when `key` is a known toggleable module. */
export function isModuleKey(key: string): key is ModuleKey {
  return MODULE_KEY_SET.has(key);
}

/**
 * Modules switched OFF in code, pending a holistic rebuild.
 *
 * A key listed here is hard-off for every account regardless of the
 * per-user opt-in or the operator-availability layer: the gate short-
 * circuits it to disabled (`resolveModuleEnabled`), the Modules hub and the
 * operator-availability panel drop its row, and the per-user PATCH surface
 * refuses to write it. The whole implementation (routes, components, schema,
 * migration) stays intact — re-enabling the module is a one-line removal
 * from this list once the rebuild lands.
 *
 * Currently empty. `inboundDocuments` was parked here from v1.25.3 until the
 * document vault re-enabled it (per-user opt-in + operator availability
 * resume their normal two-layer resolution; the module still ships dark by
 * default via `optIn`).
 */
export const CODE_DISABLED_MODULE_KEYS = [] as const;

const CODE_DISABLED_MODULE_SET: ReadonlySet<string> = new Set(
  CODE_DISABLED_MODULE_KEYS,
);

/**
 * True for a module intentionally switched off in code pending a rebuild
 * (see `CODE_DISABLED_MODULE_KEYS`). Such a module is hard-off everywhere:
 * the gate never reports it enabled and the user-facing toggles drop it.
 */
export function isCodeDisabledModule(key: ModuleKey): boolean {
  return CODE_DISABLED_MODULE_SET.has(key);
}

/** The two delegated keys, resolved by their existing source of truth. */
export function moduleDelegatesTo(
  key: ModuleKey,
): ModuleDelegation | undefined {
  return MODULE_REGISTRY[key].delegatesTo;
}

/**
 * True for a module whose per-user default is OFF (opt-in). The gate reads
 * such a key as enabled only on an explicit `true`, the inverse of the
 * disabled-allowlist default-on posture. See `ModuleDefinition.optIn`.
 */
export function isOptInModule(key: ModuleKey): boolean {
  return MODULE_REGISTRY[key].optIn === true;
}

/* ─── Needs-based onboarding: the areas a person names → the modules ───────── */

/**
 * v1.39 (C1) — the nine areas the needs questionnaire offers (design spec
 * §"The questions", Q2), as stable slugs.
 *
 * They live here rather than in the flow because the answer only means
 * something as a set of modules, and the mapping below is what gives it that
 * meaning. Putting the map next to `MODULE_KEYS` is what keeps a module key
 * renamed or retired from leaving a dangling area behind: the record type
 * makes it a compile error rather than a silently empty selection.
 *
 * All nine stay visible, cycle included — it is one chip, and hiding it behind
 * recorded sex would make the flow guess at something the person is being
 * asked about anyway.
 */
export const ONBOARDING_AREA_KEYS = [
  "blood-pressure",
  "weight-body",
  "glucose",
  "sleep",
  "mood",
  "cycle",
  "activity",
  "labs",
  "illness",
] as const;

export type OnboardingAreaKey = (typeof ONBOARDING_AREA_KEYS)[number];

/**
 * The area → module map. Every area names at least one module; blood pressure
 * and weight name only `insights`, because the readings themselves are CORE
 * (weight / blood pressure / pulse have no key and can never be switched off)
 * and the narrative layer is the only thing an answer can decide there.
 *
 * `cycle` is in the map and is NOT written through `modulePreferencesJson`:
 * that key delegates to `CycleProfile.cycleTrackingEnabled`, so the derivation
 * reports it separately (see {@link DerivedModuleDefaults.cycleTracking}) and
 * the caller writes the real column. `coach` appears nowhere: the flow never
 * talks to an AI provider, and turning the Coach on is a Settings decision
 * with a cost attached to it.
 */
export const ONBOARDING_AREA_MODULES: Readonly<
  Record<OnboardingAreaKey, readonly ModuleKey[]>
> = Object.freeze({
  "blood-pressure": ["insights"],
  "weight-body": ["insights"],
  glucose: ["glucose", "insights"],
  sleep: ["sleep", "recovery"],
  // "Mood and mental wellbeing" is one chip over two modules: the daily mood
  // entry and the WHO-5 / PHQ-9 / GAD-7 check-in live on the same surface as
  // far as the person answering is concerned.
  mood: ["mood", "mentalHealth"],
  cycle: ["cycle"],
  activity: ["workouts"],
  labs: ["labs"],
  illness: ["illness"],
});

/**
 * Modules that stay on whatever the answers say (design spec §"Needs → modules
 * → first result"): the measurement engine is CORE and has no key, and these
 * three are the surfaces a record is unusable without — the narrative layer,
 * the badges, and the document vault.
 */
export const ONBOARDING_ALWAYS_ON_MODULES: readonly ModuleKey[] = [
  "insights",
  "achievements",
  "inboundDocuments",
];

/**
 * The answers the module derivation actually reads. The flow stores more than
 * this (the sources, the units); nothing else changes which modules are on.
 *
 * The literal unions are written here rather than imported so this file keeps
 * depending on nothing. `src/lib/onboarding/needs.ts` declares the same
 * vocabulary with `satisfies`, and the derivation call site is typed against
 * this interface — a value that drifts apart fails to compile there.
 */
export interface OnboardingModuleNeeds {
  recordTarget: "me" | "someone-else" | "both";
  areas: readonly OnboardingAreaKey[];
  medication: "yes" | "no" | "sometimes";
  visit: "within-a-month" | "later" | "no";
}

/** A toggleable module whose state `modulePreferencesJson` really owns. */
export type OwnedModuleKey = Exclude<ModuleKey, ModuleDelegation>;

/** Toggleable modules minus the two delegated keys, in registry order. */
export const OWNED_MODULE_KEYS: readonly OwnedModuleKey[] = MODULE_KEYS.filter(
  (key): key is OwnedModuleKey =>
    MODULE_REGISTRY[key].delegatesTo === undefined,
);

export interface DerivedModuleDefaults {
  /**
   * An explicit value for every directly-owned module: `true` for what the
   * answers named, `false` for the rest. Explicit `false` rather than absence
   * is the "ordering versus removal" decision from the design spec — the
   * stored map is a disabled allowlist, so absence would mean ON.
   */
  preferences: Record<OwnedModuleKey, boolean>;
  /**
   * Whether the answers asked for cycle tracking. Only ever `true` here: the
   * gate derives an unanswered cycle from recorded sex, and an area the person
   * did not tick is not a statement that they want it switched off. The caller
   * writes `CycleProfile.cycleTrackingEnabled` when this is true and leaves
   * the column alone when it is not.
   */
  cycleTracking: boolean;
}

/**
 * Turn the needs answers into the module map the record starts from.
 *
 * Pure and total: every directly-owned key gets a value, so the caller never
 * has to reason about which keys the answers happened to mention. It says
 * nothing about what the record already holds — merging is
 * {@link mergeDerivedModulePreferences}, deliberately a second step, because
 * "what the answers imply" and "what this person already decided by hand" are
 * different questions and only one of them may be overwritten.
 */
export function deriveOnboardingModuleDefaults(
  needs: OnboardingModuleNeeds,
): DerivedModuleDefaults {
  const on = new Set<ModuleKey>(ONBOARDING_ALWAYS_ON_MODULES);

  for (const area of needs.areas) {
    for (const key of ONBOARDING_AREA_MODULES[area] ?? []) on.add(key);
  }
  if (needs.medication === "yes" || needs.medication === "sometimes") {
    on.add("medications");
  }
  // A visit that is coming at all is what the doctor report is for; "no" is
  // the only answer that leaves the export surface off.
  if (needs.visit === "within-a-month" || needs.visit === "later") {
    on.add("doctorReport");
  }
  // A record somebody else runs is usually a child's or a parent's, and the
  // immunization log is the part of it that matters most there.
  if (needs.recordTarget === "someone-else" || needs.recordTarget === "both") {
    on.add("vaccinations");
  }

  const preferences = {} as Record<OwnedModuleKey, boolean>;
  for (const key of OWNED_MODULE_KEYS) preferences[key] = on.has(key);

  return { preferences, cycleTracking: on.has("cycle") };
}

/**
 * Merge a derived map into the one the record already holds, without ever
 * retracting a decision the person made by hand.
 *
 * The rule is one-directional: a derived `true` always lands, a derived
 * `false` lands only where the stored map does not already carry an explicit
 * `true`. Someone who switched the MCP endpoint on, then ran the flow again
 * and did not tick anything that implies it, keeps it on — the questionnaire
 * orders a record, it does not undo it.
 *
 * Keys the stored map carries that are not module keys are dropped; the caller
 * is expected to have normalised it (`normalisePrefs`), and this is the second
 * belt on the same trousers rather than a place to be clever.
 */
export function mergeDerivedModulePreferences(
  existing: Readonly<Record<string, boolean>>,
  derived: Readonly<Record<OwnedModuleKey, boolean>>,
): Record<string, boolean> {
  const merged: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(existing)) {
    if (isModuleKey(key)) merged[key] = value;
  }
  for (const [key, value] of Object.entries(derived)) {
    if (value) {
      merged[key] = true;
      continue;
    }
    if (merged[key] === true) continue; // switched on by hand — never retracted
    merged[key] = false;
  }
  return merged;
}
