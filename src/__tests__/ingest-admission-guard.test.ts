/**
 * Every route the native client syncs through in bulk runs behind the
 * heavy-ingest gate (`src/lib/ingest/admission.ts`).
 *
 * A first Apple Health sync on a fresh account posted about 80 batches, a few
 * dozen ECG strips, the year's mood and cycle days and the workouts within
 * three minutes, and the process ran out of heap on a 1 GB container, ending
 * the app for every account on the instance. The gate bounds how many of
 * those requests hold their bodies and rows at once; a bulk route that skips
 * it reopens the hole for whatever it ingests. So every POST route under
 * `src/app/api` that looks like a bulk route by either of two independent
 * signs must wrap its POST in `withIngestAdmission`, or be listed with the
 * reason it is not an ingest:
 *
 * - its last path segment has `batch` or `bulk` as a word (`batch`,
 *   `fhir-batch`, `bulk-delete`). Up to 1.49.0 the matcher took only the
 *   bare words, and `labs/fhir-batch` (Health Records, up to 1 MiB a body)
 *   ran outside the gate;
 * - its source names a `…Batch…Schema` or `…Bulk…Schema`, so a bulk body
 *   behind a route name that does not say so is still found;
 *
 * and every named sync route below.
 */
import { describe, expect, it } from "vitest";

import {
  readSourceText,
  requireFloor,
  stripComments,
  walkSourceFiles,
} from "./helpers/source-files";

const API = "src/app/api";

/** Sync routes the client posts in bulk whose path does not say so. */
const NAMED_SYNC_ROUTES = ["insights/ecg/route.ts"];

/** Bulk-shaped routes that ingest nothing, with the reason. */
const NOT_INGEST: Readonly<Record<string, string>> = {
  "documents/inbound/bulk/route.ts":
    "acts on up to 100 stored documents by id; its body is a list of ids",
  "measurements/bulk-delete/route.ts":
    "deletes by id or by a selector; the body is a list of ids, nothing is ingested",
  "mood-entries/bulk-delete/route.ts":
    "deletes by id; the body is a list of ids, nothing is ingested",
  "medications/[id]/intake/bulk-delete/route.ts":
    "deletes one medication's intake rows by id or range; nothing is ingested",
  "measurements/route.ts":
    "the single-reading route; its array form is at most five readings (blood pressure with pulse), not a sync batch",
};

const BULK_WORD = /(?:^|-)(?:batch|bulk)(?:-|$)/;
const BULK_SCHEMA = /\b\w*(?:Batch|Bulk)\w*Schema\b/;

function bulkByName(rel: string): boolean {
  return BULK_WORD.test(rel.split("/").at(-2) ?? "");
}

function bulkBySchema(rel: string): boolean {
  return BULK_SCHEMA.test(stripComments(readSourceText(`${API}/${rel}`)));
}

function postsInBulk(rel: string): boolean {
  return (
    bulkByName(rel) || bulkBySchema(rel) || NAMED_SYNC_ROUTES.includes(rel)
  );
}

describe("heavy ingest routes run behind the admission gate", () => {
  const routes = walkSourceFiles(API, { floor: 500 }).filter(
    (rel) => rel.endsWith("/route.ts") && postsInBulk(rel),
  );
  const posting = routes.filter((rel) =>
    /export const POST\b/.test(stripComments(readSourceText(`${API}/${rel}`))),
  );

  it("finds the bulk routes", () => {
    requireFloor("bulk POST routes", posting, 14);
  });

  it("matches a hyphenated bulk name and a bulk schema behind any name", () => {
    expect(bulkByName("labs/fhir-batch/route.ts")).toBe(true);
    expect(bulkByName("measurements/bulk-delete/route.ts")).toBe(true);
    expect(bulkByName("workouts/batch/route.ts")).toBe(true);
    expect(bulkByName("labs/batchelor/route.ts")).toBe(false);
    expect(BULK_SCHEMA.test("const p = fhirLabBatchSchema.parse(b)")).toBe(
      true,
    );
    expect(BULK_SCHEMA.test("const p = labSchema.parse(b)")).toBe(false);
    expect(posting).toContain("labs/fhir-batch/route.ts");
  });

  it("wraps every bulk POST in withIngestAdmission", () => {
    const missing = posting.filter((rel) => {
      if (rel in NOT_INGEST) return false;
      const source = stripComments(readSourceText(`${API}/${rel}`));
      const post =
        /export const POST\s*=\s*([\s\S]*?);\n/.exec(source)?.[1] ?? "";
      return !/withIngestAdmission\(/.test(post);
    });
    expect(missing).toEqual([]);
  });

  it("lists no exemption that is gone or wrapped after all", () => {
    for (const rel of Object.keys(NOT_INGEST)) {
      expect(posting).toContain(rel);
      const source = stripComments(readSourceText(`${API}/${rel}`));
      expect(source).not.toContain("withIngestAdmission(");
    }
    for (const rel of NAMED_SYNC_ROUTES) expect(posting).toContain(rel);
  });
});
