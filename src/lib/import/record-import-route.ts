/**
 * The request side the two CSV record imports share (#1215): owner-only auth,
 * the module gate, the rate buckets, the query parse, the content type and
 * the streamed body with its byte cap. Each route supplies its schema and its
 * importer; what a row becomes lives in `labs-csv.ts` / `medications-csv.ts`.
 *
 * Buckets: a dry run spends `import-preview:<id>` (30 an hour), because the
 * mapping screen re-checks the file whenever a column choice changes; the
 * real import spends the `import:<id>` bucket it shares with the
 * other buffered imports: the measurements CSV, the JSON import and the dose
 * history import. The staged file uploads (Apple Health, Health Connect, FIT,
 * Gadgetbridge, FHIR Bundle) spend their own per-kind bucket instead
 * (`src/lib/import/staged-upload.ts`).
 */
import type { NextRequest } from "next/server";
import type { z } from "zod/v4";

import { requireAuth } from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  getClientIp,
  returnAllZodIssues,
} from "@/lib/api-response";
import { auditLog } from "@/lib/auth/audit";
import { CsvTooLargeError } from "@/lib/import/csv-stream";
import {
  checkImportRateLimit,
  importRateLimitMessage,
} from "@/lib/import/import-rate-limit";
import { annotate } from "@/lib/logging/context";
import { requireModuleEnabled } from "@/lib/modules/gate";
import type { ModuleKey } from "@/lib/modules/registry";
import { checkRateLimit } from "@/lib/rate-limit";
import { resolveUserTimezone } from "@/lib/tz/resolver";
import type { RecordImportResult } from "@/lib/validations/record-import";

export const RECORD_IMPORT_MAX_BYTES = 16 * 1024 * 1024;
const PREVIEW_PER_HOUR = 30;
const HOUR_MS = 60 * 60 * 1000;

export async function handleRecordImport<
  S extends z.ZodType<{ dryRun: boolean }>,
>(
  request: NextRequest,
  opts: {
    kind: RecordImportResult["kind"];
    module: ModuleKey;
    schema: S;
    run: (args: {
      userId: string;
      tz: string;
      stream: ReadableStream<Uint8Array>;
      maxBytes: number;
      query: z.infer<S>;
      onWritten: (rows: number) => void;
    }) => Promise<RecordImportResult>;
  },
): Promise<Response> {
  const { user } = await requireAuth();
  const action = `import.${opts.kind}.csv`;
  annotate({ action: { name: action } });

  const gate = await requireModuleEnabled(user.id, opts.module);
  if (!gate.enabled) return gate.response;

  const parsed = opts.schema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams),
  );
  if (!parsed.success) {
    return returnAllZodIssues(parsed.error, 422, undefined, opts.schema);
  }
  const query = parsed.data;

  const rl = query.dryRun
    ? {
        ...(await checkRateLimit(
          `import-preview:${user.id}`,
          PREVIEW_PER_HOUR,
          HOUR_MS,
        )),
        limit: PREVIEW_PER_HOUR,
      }
    : await checkImportRateLimit(user.id);
  if (!rl.allowed) {
    return apiError(
      query.dryRun
        ? `Maximum ${rl.limit} checks per hour`
        : importRateLimitMessage(rl.limit),
      429,
      { errorCode: "import.rate_limited" },
    );
  }

  const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
  if (
    !contentType.includes("text/csv") &&
    !contentType.includes("text/plain")
  ) {
    return apiError("Content-Type must be text/csv", 415, {
      errorCode: "import.csv.content_type",
    });
  }
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > RECORD_IMPORT_MAX_BYTES) {
    return apiError("CSV exceeds the 16 MB limit", 413, {
      errorCode: "import.csv.too_large",
    });
  }
  if (!request.body) {
    return apiError("The CSV file is empty", 422, {
      errorCode: "import.csv.empty",
    });
  }

  const tz = await resolveUserTimezone(user.id);
  let result: RecordImportResult | null = null;
  let written = 0;
  try {
    result = await opts.run({
      userId: user.id,
      tz,
      stream: request.body,
      maxBytes: RECORD_IMPORT_MAX_BYTES,
      query,
      onWritten: (rows) => {
        written += rows;
      },
    });
  } catch (err) {
    if (err instanceof CsvTooLargeError) {
      return apiError("CSV exceeds the 16 MB limit", 413, {
        errorCode: "import.csv.too_large",
      });
    }
    throw err;
  } finally {
    // The audit row is written whatever happened: an import cut off part way
    // (the client went away, a proxy timed out, the cap was hit after some
    // chunks) has already written rows, and the trail says how many. A
    // failing audit write is noted on the wide event and never replaces the
    // import's own answer or error: a throw from `finally` would discard
    // both, and the rows are written either way.
    if (
      !query.dryRun &&
      ((result !== null && result.rows > 0) || written > 0)
    ) {
      try {
        await auditLog(action, {
          userId: user.id,
          ipAddress: getClientIp(request),
          details:
            result !== null
              ? {
                  rows: result.rows,
                  inserted: result.inserted,
                  duplicates: result.duplicates,
                  failed: result.failed,
                  partial: false,
                  written,
                }
              : { partial: true, written },
        });
      } catch {
        annotate({ meta: { import_audit_failed: true } });
      }
    }
  }
  if (result.rows === 0) {
    return apiError("The CSV file has no data rows", 422, {
      errorCode: "import.csv.empty",
    });
  }
  annotate({
    meta: {
      import_dry_run: query.dryRun,
      import_rows: result.rows,
      import_inserted: result.inserted,
      import_duplicates: result.duplicates,
      import_failed: result.failed,
    },
  });
  return apiSuccess(result);
}
