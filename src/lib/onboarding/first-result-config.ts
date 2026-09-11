/**
 * v1.39 (C2) — what each first-result task needs to render, as data.
 *
 * The task itself is chosen by the step machine (`chooseFirstResultTask`);
 * this file says what a task's target maps to on the surfaces that already
 * exist: which measurement form and which stored types a Q2 area means,
 * which integration a Q4 source is, and which page carries an area the
 * measurement form cannot log.
 */
import type { SyncVerdict } from "@/lib/integrations/sync-verdict";
import type { OnboardingAreaKey } from "@/lib/modules/registry";

import type { BrowserConnectableSource } from "./wizard-steps";

export interface AreaReadingTarget {
  /** The `defaultType` the measurement form opens on. */
  formType: string;
  /** The stored types the reading lands as, read back for the result tile. */
  storedTypes: readonly string[];
}

/**
 * The areas one reading in the measurement form can answer. Blood pressure
 * is one form mode over two stored rows; the rest are one type each. Mood,
 * cycle, labs and illness have their own surfaces and are linked instead
 * (`AREA_PAGE_HREF`).
 */
export const AREA_READING_TARGETS: Readonly<
  Partial<Record<OnboardingAreaKey, AreaReadingTarget>>
> = Object.freeze({
  "blood-pressure": {
    formType: "BLOOD_PRESSURE",
    storedTypes: ["BLOOD_PRESSURE_SYS", "BLOOD_PRESSURE_DIA"],
  },
  "weight-body": { formType: "WEIGHT", storedTypes: ["WEIGHT"] },
  glucose: { formType: "BLOOD_GLUCOSE", storedTypes: ["BLOOD_GLUCOSE"] },
  sleep: { formType: "SLEEP_DURATION", storedTypes: ["SLEEP_DURATION"] },
  activity: { formType: "ACTIVITY_STEPS", storedTypes: ["ACTIVITY_STEPS"] },
});

/** Where an area the form cannot log is logged instead. */
export const AREA_PAGE_HREF: Readonly<
  Partial<Record<OnboardingAreaKey, string>>
> = Object.freeze({
  mood: "/mood",
  cycle: "/cycle",
  labs: "/labs",
  illness: "/illness",
});

/**
 * How a source's connection is authorised on this instance, which decides
 * what "cannot be connected yet" means for it:
 *
 * - `byo` — the OAuth app is per-user only (`configured` is the stored client
 *   id/secret pair). With none, the provider card renders a credentials note
 *   and no connect button at all, so offering "Connect" walks the person into
 *   a dead end.
 * - `shared` — an operator env app is the fallback (`available` says whether
 *   any usable credentials resolve, own or shared).
 * - `self-hosted` — a URL the person pastes; nothing can be missing up front.
 */
export type SourceCredentialModel = "byo" | "shared" | "self-hosted";

/**
 * The connections panel's anchor for each connectable source — the `id` of
 * the provider card on Settings → Integrations, and the key its status is
 * published under on `/api/integrations/status`.
 */
export const SOURCE_INTEGRATION: Readonly<
  Record<
    BrowserConnectableSource,
    { anchor: string; statusKey: string; credentials: SourceCredentialModel }
  >
> = Object.freeze({
  withings: { anchor: "withings", statusKey: "withings", credentials: "byo" },
  oura: { anchor: "oura", statusKey: "oura", credentials: "shared" },
  whoop: { anchor: "whoop", statusKey: "whoop", credentials: "byo" },
  polar: { anchor: "polar", statusKey: "polar", credentials: "shared" },
  fitbit: { anchor: "fitbit", statusKey: "fitbit", credentials: "byo" },
  strava: { anchor: "strava", statusKey: "strava", credentials: "shared" },
  nightscout: {
    anchor: "nightscout",
    statusKey: "nightscout",
    credentials: "self-hosted",
  },
});

/** Which tile the connect step renders. */
export type ConnectSourceSlot =
  /** Nothing is connected and something can be: today's connect card. */
  | "connect"
  /** Nothing is connected and nothing CAN be: point at the credentials. */
  | "credentials"
  /** A working connection — the flow's result, whether or not it is new. */
  | "result"
  /** A connection the person has to repair, named rather than painted green. */
  | "attention";

/** The fields of an `/api/integrations/status` entry this decision reads. */
export interface ConnectSourceStatus {
  connected?: boolean;
  configured?: boolean;
  available?: boolean;
  state?: string;
  syncHealth?: { verdict: SyncVerdict; since: string | null };
  lastSuccessAt?: string | null;
}

export interface ConnectSourceView {
  slot: ConnectSourceSlot;
  verdict: SyncVerdict;
  /**
   * Whether the flow may record this as the completed first result. Only a
   * connection that is delivering, or one whose first sync is under way —
   * never a connection that needs repairing, and never the mere absence of a
   * ledger row.
   */
  settled: boolean;
  /** The instant the copy names, or null when there is none to name. */
  when: string | null;
}

/**
 * What the connect step may honestly say about one source.
 *
 * The liveness truth is `syncHealth.verdict` and nothing else — the ledger's
 * `state` is what the last ATTEMPT did, and its "no row" default used to read
 * as `connected`, which is how a brand-new account was told its wearable was
 * connected and had the flow's one result stamped as achieved on its behalf.
 *
 * Returns `null` while the envelope has not resolved: an unloaded status is
 * not evidence of anything, and the screen says nothing rather than guessing.
 */
export function connectSourceView(
  source: BrowserConnectableSource,
  status: ConnectSourceStatus | undefined,
): ConnectSourceView | null {
  if (!status) return null;
  const verdict = status.syncHealth?.verdict ?? "disconnected";
  const settled = verdict === "pending_first_sync" || verdict === "fresh";
  const when =
    verdict === "fresh" || verdict === "stale"
      ? (status.lastSuccessAt ?? status.syncHealth?.since ?? null)
      : (status.syncHealth?.since ?? status.lastSuccessAt ?? null);

  if (settled || verdict === "stale") {
    return { slot: "result", verdict, settled, when };
  }
  if (verdict !== "disconnected") {
    return { slot: "attention", verdict, settled, when };
  }
  return {
    slot: canStartConnection(source, status) ? "connect" : "credentials",
    verdict,
    settled,
    when,
  };
}

/**
 * Whether the connect CTA leads anywhere. A `byo` provider without its client
 * pair and a `shared` provider without any resolvable app both land on a card
 * that has no connect button — the dead end the flow used to walk into.
 */
function canStartConnection(
  source: BrowserConnectableSource,
  status: ConnectSourceStatus,
): boolean {
  switch (SOURCE_INTEGRATION[source].credentials) {
    case "byo":
      return status.configured !== false;
    case "shared":
      return status.available !== false;
    case "self-hosted":
      return true;
  }
}
