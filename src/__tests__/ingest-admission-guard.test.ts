/**
 * Every route the native client syncs through in bulk runs behind the
 * heavy-ingest gate (`src/lib/ingest/admission.ts`).
 *
 * A first Apple Health sync on a fresh account posted about 80 batches, a few
 * dozen ECG strips, the year's mood and cycle days and the workouts within
 * three minutes, and the process ran out of heap on a 1 GB container, ending
 * the app for every account on the instance. The gate bounds how many of
 * those requests hold their bodies and rows at once; a bulk route that skips
 * it reopens the hole for whatever it ingests. So every route under
 * `src/app/api` whose last segment is `batch` or `bulk` and that accepts a
 * POST, and every named sync route below, must wrap its POST in
 * `withIngestAdmission`, or be listed with the reason it is not an ingest.
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
};

function postsInBulk(rel: string): boolean {
  const segments = rel.split("/");
  const last = segments.at(-2);
  return last === "batch" || last === "bulk" || NAMED_SYNC_ROUTES.includes(rel);
}

describe("heavy ingest routes run behind the admission gate", () => {
  const routes = walkSourceFiles(API, { floor: 500 }).filter(
    (rel) => rel.endsWith("/route.ts") && postsInBulk(rel),
  );
  const posting = routes.filter((rel) =>
    /export const POST\b/.test(stripComments(readSourceText(`${API}/${rel}`))),
  );

  it("finds the bulk routes", () => {
    requireFloor("bulk POST routes", posting, 9);
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
