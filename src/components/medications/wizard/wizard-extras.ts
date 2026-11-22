/**
 * The medication's free-standing extras in the wizard: the person's own note
 * (#1371) and the official leaflet link they saved (#1430).
 *
 * Neither shapes the schedule, so they share one rule: a create sends a value
 * only when there is one, and an edit names a field only when it changed, so
 * an unrelated save never clears it. A blank value on an edit clears it.
 */

/** The draft fields, on `WizardPayload`. */
export interface WizardExtras {
  /** #1371 — the medication's own note; empty = none. */
  note: string;
  /** #1371 — the note an edit hydrated to; absent on create. */
  initialNote?: string;
  /** #1430 — the saved leaflet link; empty = none. */
  leafletUrl: string;
  /** #1430 — the link an edit hydrated to; absent on create. */
  initialLeafletUrl?: string;
}

/** The request fields, on `CreateMedicationBody`. */
export interface ExtrasBody {
  /** #1371 — trimmed; sent only when set (create) or changed (edit). */
  note?: string;
  /** #1430 — trimmed; sent only when set (create) or changed (edit). */
  leafletUrl?: string;
}

/** The stored values, on `MedicationPayload`. */
export interface ExtrasInitial {
  /** #1371 — the person's own note; null or absent = none. */
  note?: string | null;
  /** #1430 — the saved leaflet link; null or absent = none. */
  leafletUrl?: string | null;
}

export const EMPTY_EXTRAS: WizardExtras = { note: "", leafletUrl: "" };

export function hydrateExtras(initial: ExtrasInitial): WizardExtras {
  return {
    note: initial.note ?? "",
    initialNote: initial.note ?? "",
    leafletUrl: initial.leafletUrl ?? "",
    initialLeafletUrl: initial.leafletUrl ?? "",
  };
}

export function extrasBody(
  committed: WizardExtras,
  forMode: "create" | "edit",
): ExtrasBody {
  const edit = forMode === "edit";
  const note = committed.note.trim();
  const leafletUrl = committed.leafletUrl.trim();
  return {
    ...(note !== (edit ? (committed.initialNote ?? "").trim() : "") && {
      note,
    }),
    ...(leafletUrl !==
      (edit ? (committed.initialLeafletUrl ?? "").trim() : "") && {
      leafletUrl,
    }),
  };
}
