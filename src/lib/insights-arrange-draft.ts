/**
 * Pure draft logic for the Insights overview arrange editor.
 *
 * The editor owns `sections` (order + visibility) only. The pill manager on
 * Settings → Insights writes the same `/api/insights/layout` blob, so a save
 * here must carry the CURRENT server tiles rather than a copy taken when the
 * editor mounted: the base token is read from the shared cache at save time,
 * so a stale tile copy would never 409 and would silently undo a pill save.
 *
 * For the same reason the section draft follows the server copy whenever the
 * user has not touched it — the pill manager also flips the `"ecg"` section's
 * visibility, and an untouched draft must not turn that into a pending edit.
 */
import type {
  InsightsLayout,
  InsightsSectionConfig,
  InsightsTileConfig,
} from "@/lib/insights-layout";

export function sortByOrder<T extends { order: number }>(
  rows: readonly T[],
): T[] {
  return [...rows].sort((a, b) => a.order - b.order);
}

/** Order + visibility fingerprint of a section list. */
export function arrangementSignature(
  rows: readonly InsightsSectionConfig[],
): string {
  return sortByOrder(rows)
    .map((r) => `${r.id}:${r.visible ? 1 : 0}`)
    .join(",");
}

export interface ArrangeDraftState {
  /** Server signature the draft was last seeded from. */
  seeded: string;
  sections: InsightsSectionConfig[];
}

export function seedArrangeDraft(
  serverSections: readonly InsightsSectionConfig[],
): ArrangeDraftState {
  return {
    seeded: arrangementSignature(serverSections),
    sections: sortByOrder(serverSections),
  };
}

/**
 * Follow a server-side change to the sections. Returns `null` when nothing
 * needs to change. An untouched draft re-seeds; a draft carrying the user's
 * own edits is kept, only the baseline advances.
 */
export function reconcileArrangeDraft(
  state: ArrangeDraftState,
  serverSections: readonly InsightsSectionConfig[],
): ArrangeDraftState | null {
  const server = arrangementSignature(serverSections);
  if (server === state.seeded) return null;
  const untouched = arrangementSignature(state.sections) === state.seeded;
  return untouched
    ? seedArrangeDraft(serverSections)
    : { seeded: server, sections: state.sections };
}

/** The PUT body: the draft's sections over the current server tiles. */
export function arrangeSavePayload(
  draftSections: readonly InsightsSectionConfig[],
  current: Pick<InsightsLayout, "tiles">,
): {
  version: 2;
  sections: InsightsSectionConfig[];
  tiles: InsightsTileConfig[];
} {
  return {
    version: 2,
    sections: [...draftSections],
    tiles: [...current.tiles],
  };
}
