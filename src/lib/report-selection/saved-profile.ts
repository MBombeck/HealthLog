/**
 * The owner's saved report selection — "my selection" — read from the row.
 *
 * Persisted on `User.reportSelectionJson` and written after a successful
 * generation, the same way the practice name is. Two kinds of caller read it:
 *
 *   - the export panel and the share-link create form, so the panel opens
 *     already carrying the last scope the owner chose, and
 *   - the surfaces that cannot ask a human — the FHIR REST face and the MCP
 *     doctor-visit resource and prompt.
 *
 * The second group is the reason this exists. Those three call sites used to
 * assemble the full record at server defaults. Now they replay a real act by
 * the owner: the same object reviewed in Settings, no more and no less. An
 * account that has never saved one resolves to the EMPTY selection, so an
 * assistant asking for a record the owner never scoped gets nothing — not a
 * template, not a guess.
 *
 * The shape itself lives in `./profile-shape` so the client panel can parse
 * the blob without pulling the Prisma client into the browser bundle.
 */
import { prisma } from "@/lib/db";
import { isReportLeafId } from "./catalogue";
import { parseSavedProfile } from "./profile-shape";
import {
  EMPTY_REPORT_SELECTION,
  selectionFromLeaves,
  selectionFromStoredBlob,
  type ReportSelection,
} from "./selection";

/**
 * The selection inside a stored profile blob.
 *
 * The export writes the profile with its render choices beside the leaves
 * (`format`, `rangeDays`, `includeCharts`), and the bare selection schema is
 * strict, so reading the row through it alone turned every saved profile into
 * the empty selection. The profile shape is read first; a bare `{ v, leaves }`
 * blob still reads as before. Unknown leaf ids are dropped, never added to,
 * and any other shape is the empty selection.
 */
export function selectionFromSavedProfile(raw: unknown): ReportSelection {
  const profile = parseSavedProfile(raw);
  if (profile)
    return selectionFromLeaves(profile.leaves.filter(isReportLeafId));
  return selectionFromStoredBlob(raw);
}

/**
 * Resolve the owner's saved selection.
 *
 * Anything that is not a well-formed v2 blob — null, a drifted shape, a
 * hand-edited row — resolves to the empty selection. A shape the server cannot
 * read is not consent to anything.
 */
export async function resolveSavedSelection(
  userId: string,
): Promise<ReportSelection> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { reportSelectionJson: true },
  });
  if (!row) return EMPTY_REPORT_SELECTION;
  return selectionFromSavedProfile(row.reportSelectionJson);
}
