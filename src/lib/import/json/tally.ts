import type { UnstableExternalIdShape } from "@/lib/validations/external-id";

/** The running counts of one JSON import, shared by its row writers. */
export interface JsonImportTally {
  stats: { measurements: number; moodEntries: number; skipped: number };
  unstableShapes: UnstableExternalIdShape[];
  /**
   * Link keys of imported mood entries that the importing account cannot
   * resolve (a custom tag of the account the file came from, a retired
   * catalogue key). The entry lands without that link; the key is named.
   */
  droppedTagKeys: Set<string>;
  droppedFactorKeys: Set<string>;
  /**
   * The account's own tags and groups whose key the file shares and whose
   * label it states differently. The account's version is kept, never
   * overwritten; the key is named.
   */
  keptMoodTagKeys: Set<string>;
  keptMoodCategoryKeys: Set<string>;
  /** A write failed for a reason other than a duplicate; the import stops. */
  writeFailed: boolean;
}

export function newJsonImportTally(): JsonImportTally {
  return {
    stats: { measurements: 0, moodEntries: 0, skipped: 0 },
    unstableShapes: [],
    droppedTagKeys: new Set(),
    droppedFactorKeys: new Set(),
    keptMoodTagKeys: new Set(),
    keptMoodCategoryKeys: new Set(),
    writeFailed: false,
  };
}
