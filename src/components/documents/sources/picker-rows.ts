/**
 * The document picker's row logic, apart from its rendering: which rows can be
 * ticked, which ask for a deleted document back, what a held row's badge and
 * a finished row's result say, and how a whole run went.
 */
import type {
  DocumentImportOutcome,
  DocumentSourceResultDto,
} from "@/lib/documents/sources/types";
import type { WrittenOutcome } from "@/lib/outcome/written-outcome";

export type RowRun =
  | { state: "waiting" }
  | { state: "working" }
  | { state: DocumentImportOutcome; linked: boolean }
  | { state: "failed"; message: string };

/**
 * Whether a result row can be ticked: a new one always; one deleted here too,
 * since ticking it asks for it back (`revive`); an already imported one only
 * when the pick does something with it: link it, or hand it to the form.
 */
export function isPickable(
  row: DocumentSourceResultDto,
  canTakeImported: boolean,
): boolean {
  if (row.state === "imported") return canTakeImported;
  return true;
}

/** The rows the vault holds as deleted: ticking one asks for it back. */
export function deletedSourceIds(rows: DocumentSourceResultDto[]): Set<string> {
  return new Set(
    rows.filter((r) => r.state === "deleted").map((r) => r.sourceId),
  );
}

/**
 * The badge on a row the vault already holds. A deleted one still in Recently
 * deleted (the search names it) says so; one removed for good says deleted.
 */
export function heldBadgeLabel(
  t: (key: string) => string,
  row: DocumentSourceResultDto,
): string {
  if (row.state === "imported") {
    return t("documents.sourcePicker.stateImported");
  }
  return row.documentId
    ? t("documents.sourcePicker.stateInTrash")
    : t("documents.sourcePicker.stateDeleted");
}

/** How the run went, in the shared outcome vocabulary. */
export function runOutcome(counts: {
  imported: number;
  present: number;
  failed: number;
}): WrittenOutcome {
  const held = counts.imported + counts.present;
  if (counts.failed === 0) return held > 0 ? "success" : "empty";
  return held > 0 ? "partial" : "failed";
}

/** A row's result in words, or null while it has none yet. */
export function runLabel(
  t: (key: string, params?: Record<string, string | number>) => string,
  run: RowRun,
): string | null {
  switch (run.state) {
    case "waiting":
    case "working":
      return null;
    case "failed":
      return run.message;
    case "deleted":
      return t("documents.sourcePicker.result.deleted");
    case "restored":
      return run.linked
        ? t("documents.sourcePicker.result.restoredLinked")
        : t("documents.sourcePicker.result.restored");
    case "imported":
      return run.linked
        ? t("documents.sourcePicker.result.importedLinked")
        : t("documents.sourcePicker.result.imported");
    case "duplicate":
      return run.linked
        ? t("documents.sourcePicker.result.duplicateLinked")
        : t("documents.sourcePicker.result.duplicate");
  }
}
