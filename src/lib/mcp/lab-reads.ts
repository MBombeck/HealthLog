/**
 * The latest-per-marker labs read behind `get_labs` and `fetch lab:`, with
 * what each reading is linked to.
 *
 * A present read builds the same block the Coach's `get_labs` returns
 * (`buildLabsSnapshotBlock`, the whole record, as an MCP read has no lookback
 * limit), asking it to carry each reading's lab result id. A miss falls back
 * to the caller's Coach read, which owns the grounded empty answer (what the
 * record holds, `analyte_not_found`).
 *
 * The links of a reading are the report it was read from (a document, behind
 * the Documents module) and the visits it is filed against. A labs answer
 * lists many readings, and one report usually holds a whole panel, so the
 * answer names each linked record once, in `linkedRecords`, and a reading
 * carries the ids of its links only. Every id there is one `fetch` accepts,
 * and so is the reading's own `id` (`labresult:<id>`, that one reading).
 */
import { buildLabsSnapshotBlock } from "@/lib/ai/coach/labs-snapshot";
import { UNBOUNDED_REACH } from "@/lib/ai/coach/history-reach";
import {
  boundLinks,
  labResultFetchId,
  linksBySource,
  type RecordLink,
} from "./record-links";

/** What a lab result lists as linked, in this order. */
export const LAB_LINK_TARGETS = ["document", "encounter"] as const;

/** The latest reading per marker with ids, or `fallback()` on a miss. */
export async function readLatestLabs(
  userId: string,
  analyte: string | undefined,
  fallback: () => Promise<unknown>,
): Promise<unknown> {
  const data = await buildLabsSnapshotBlock(
    userId,
    new Date(),
    UNBOUNDED_REACH,
    { analyte, withIds: true },
  );
  return data ? { present: true, data } : fallback();
}

type IdReading = Record<string, unknown> & { id: string };

/** Every reading of a labs answer that carries its lab result id. */
function idReadings(result: unknown): IdReading[] {
  const r = result as {
    readings?: unknown[];
    data?: { recent?: Array<{ history?: { earlier?: unknown[] } }> };
  } | null;
  const list: unknown[] = [
    ...(Array.isArray(r?.readings) ? r.readings : []),
    ...(Array.isArray(r?.data?.recent) ? r.data.recent : []).flatMap(
      (entry) => [entry, ...(entry?.history?.earlier ?? [])],
    ),
  ];
  return list.filter(
    (x): x is IdReading =>
      typeof x === "object" &&
      x !== null &&
      typeof (x as { id?: unknown }).id === "string",
  );
}

/**
 * Turn each reading's lab result id into its `fetch` id (`labresult:<id>`),
 * add the ids of what it links to (`links`, bounded, with `linksTruncated`),
 * and add the linked records once each as `linkedRecords`. A reading linked
 * to nothing carries `links: []`.
 * An answer without ids (a miss) comes back unchanged. `result` must be the
 * caller's own copy: its readings are rewritten in place.
 */
export async function attachLabLinks(
  userId: string,
  result: unknown,
): Promise<unknown> {
  const readings = idReadings(result);
  if (readings.length === 0) return result;
  const bySource = await linksBySource(
    userId,
    "labResult",
    [...new Set(readings.map((r) => r.id))],
    LAB_LINK_TARGETS,
  );
  const table = new Map<string, RecordLink>();
  for (const reading of readings) {
    const { links, linksTruncated } = boundLinks(
      bySource.get(reading.id) ?? [],
    );
    reading.id = labResultFetchId(reading.id);
    reading.links = links.flatMap((l) => (l.id ? [l.id] : []));
    reading.linksTruncated = linksTruncated;
    for (const link of links) {
      if (link.id && !table.has(link.id)) table.set(link.id, link);
    }
  }
  return { ...(result as object), linkedRecords: [...table.values()] };
}

/** The links of one lab result, bounded, for a single-record `fetch`. */
export async function labResultLinks(
  userId: string,
  labResultId: string,
): Promise<{ links: RecordLink[]; linksTruncated: boolean }> {
  const bySource = await linksBySource(
    userId,
    "labResult",
    [labResultId],
    LAB_LINK_TARGETS,
  );
  return boundLinks(bySource.get(labResultId) ?? []);
}
