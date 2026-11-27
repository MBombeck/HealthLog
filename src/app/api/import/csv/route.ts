import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import {
  apiSuccess,
  apiError,
  getClientIp,
  readBodyText,
  returnAllZodIssues,
} from "@/lib/api-response";
import { csvImportQuerySchema } from "@/lib/validations/record-import";
import {
  checkImportRateLimit,
  importRateLimitMessage,
} from "@/lib/import/import-rate-limit";
import { NextRequest } from "next/server";

import {
  CsvShapeLimitError,
  parseCsvMeasurements,
} from "@/lib/import/csv-measurements";
import { runCsvImport, type CsvOkRow } from "@/lib/import/csv-write";

/**
 * CSV measurement import.
 *
 * The cold-start escape hatch for self-hosters migrating from a spreadsheet
 * or another tracker. Reuses the `/api/import` write loop + rollup re-fold;
 * the parse + per-row validation + unit conversion lives in the pure
 * `parseCsvMeasurements` module so it is unit-tested without a database.
 *
 * Body is `text/csv` (or `text/plain`) raw text — NOT JSON. Capped at 16 MB
 * (the same ceiling as the JSON import; a 16 MB CSV is > 100 000 rows). Rows
 * beyond the 10 000 ceiling are rejected so the rollup re-fold stays bounded.
 *
 * `?dryRun=1` parses + validates + returns the per-row status envelope
 * WITHOUT writing — a trust win for a bulk cold-start import.
 *
 * Response: `{ inserted, updated, skipped, total, dryRun, rows: [{line,
 * status, reason}] }`, mirroring the batch route's per-entry envelope. The
 * batched writer lives in `src/lib/import/csv-write.ts`.
 */

const MAX_CSV_BYTES = 16 * 1024 * 1024;
const MAX_ROWS = 10000;

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "import.csv.upload" } });

  // Strict: an unknown parameter is refused, so a misspelt `dryrun=1` can
  // never fall through to a real import.
  const queryParse = csvImportQuerySchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams),
  );
  if (!queryParse.success) return returnAllZodIssues(queryParse.error, 422);
  const dryRun = queryParse.data.dryRun;

  // Same blast-radius reasoning as the JSON import: a CSV upload spends the
  // same shared hourly import bucket.
  const rl = await checkImportRateLimit(user.id);
  if (!rl.allowed) {
    return apiError(importRateLimitMessage(rl.limit), 429);
  }

  // Raw text read with an explicit byte cap — `safeJson` is JSON-only, so we
  // enforce the same `maxBytes` ceiling here against the Content-Length and
  // the materialised body.
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_CSV_BYTES) {
    return apiError("CSV exceeds the 16 MB limit", 413);
  }
  // Counted while it is read, so a body without a Content-Length cannot run
  // past the cap before the check.
  let text: string;
  try {
    const read = await readBodyText(request, MAX_CSV_BYTES);
    if (read.tooLarge) return apiError("CSV exceeds the 16 MB limit", 413);
    text = read.text;
  } catch {
    return apiError("Could not read the request body", 400);
  }

  let parsed: ReturnType<typeof parseCsvMeasurements>;
  try {
    parsed = parseCsvMeasurements(text);
  } catch (err) {
    if (err instanceof CsvShapeLimitError) return apiError(err.message, 422);
    throw err;
  }
  if (parsed.fatal) {
    return apiError(parsed.fatal.message, 422);
  }

  const okRows = parsed.rows.filter(
    (r): r is CsvOkRow => r.status === "ok" && r.row !== undefined,
  );
  if (okRows.length > MAX_ROWS) {
    return apiError(
      `CSV has ${okRows.length} valid rows. The limit is ${MAX_ROWS} per import`,
      422,
    );
  }

  return apiSuccess(
    await runCsvImport({
      userId: user.id,
      rows: parsed.rows,
      okRows,
      dryRun,
      ipAddress: getClientIp(request),
    }),
  );
});
