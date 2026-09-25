/**
 * POST /api/admin/backups/upload — admin-only ingest of a backup file.
 *
 * Accepts the backup file either as the raw request body (JSON, or JSON
 * compressed with gzip) or, for a small file, as a `multipart/form-data`
 * body with a single `file` field. The route:
 *
 *   1. Authenticates the caller as an admin (cookie session only).
 *   2. Reads the file (size capped — see `MAX_UPLOAD_BYTES`).
 *   3. Parses and validates the JSON against the canonical schema.
 *   4. Rejects files written by a future schema version (incompatible).
 *   5. Encrypts the file as it arrives and inserts a new `DataBackup` row
 *      of type `MANUAL_UPLOAD_<unix-ms>` so multiple uploads coexist with
 *      the rolling `WEEKLY_AUTO` snapshot AND with each other.
 *
 * The file is read as a stream and never held whole (#1031): an export of an
 * account with 1.25 million measurements is a few hundred megabytes of JSON,
 * which neither fits a 1 GB container beside the running app nor, in the
 * disaster-recovery shape, fits in one JavaScript string at all. It is
 * checked as it goes and stored in the same pass; a file that fails any check
 * rolls the store back, so nothing of it remains.
 *
 * Crucially, this route does NOT execute a restore. It only stores the
 * file. The separate `POST /api/admin/backups/[id]/restore` endpoint
 * (criterion 3) actually replaces user data — keeping the two phases
 * apart is the whole reason an admin can review what they uploaded
 * before pulling the trigger.
 *
 * Phase B1 / criterion 2 of the v1.4.15 backup-completeness work.
 */
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";

import { NextRequest } from "next/server";
import { ZodError } from "zod/v4";
import { prisma } from "@/lib/db";
import { apiHandler, HttpError, requireAdmin } from "@/lib/api-handler";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { auditLog } from "@/lib/auth/audit";
import { BackupJsonError, scanBackupJson } from "@/lib/export/backup-json-scan";
import {
  BACKUP_UPLOAD_TOO_LARGE_CODE,
  BackupBlobTooLargeError,
} from "@/lib/export/backup-blob";
import { storeBackupBlob } from "@/lib/export/store-backup-blob";
import { StreamedBackupInvalidError } from "@/lib/export/streamed-backup";
import { annotate } from "@/lib/logging/context";
import { checkRateLimit } from "@/lib/rate-limit";
import {
  BACKUP_SCHEMA_VERSION,
  backupMeasurementSchema,
  backupPayloadSchema,
  isCompatibleSchemaVersion,
  summarizeBackup,
  type BackupPayload,
  type BackupSummary,
} from "@/lib/validations/backup";

export const dynamic = "force-dynamic";

/**
 * Cap on a file sent as a multipart form. The form parser holds the whole
 * file in memory, so this path stays for small files only; anything larger
 * is sent as the raw request body, which is read as a stream.
 */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/**
 * Cap on a file sent as the raw request body, compressed or not. The same
 * ceiling the app sets for any request body (`middlewareClientMaxBodySize` in
 * `next.config.ts`), beyond which the body would arrive truncated. A
 * disaster-recovery file of 1.25 million measurements is 662 MB as plain
 * JSON and 64 MB compressed, so large files go up compressed.
 */
const MAX_RAW_UPLOAD_BYTES = 512 * 1024 * 1024;

interface UploadResponse {
  id: string;
  valid: true;
  summary: BackupSummary;
}

/** A file the route refuses: the answer, and what the audit row records. */
class UploadRefused extends Error {
  constructor(
    readonly status: number,
    readonly answer: string,
    readonly details: Record<string, unknown>,
    readonly meta?: Record<string, unknown>,
  ) {
    super(answer);
    this.name = "UploadRefused";
  }
}

/** Bytes → bytes, gunzipped when the file starts with the gzip magic. */
async function* decodedBytes(
  source: AsyncIterable<Uint8Array>,
  limit: number,
): AsyncGenerator<Uint8Array> {
  let seen = 0;
  async function* counted() {
    for await (const chunk of source) {
      seen += chunk.byteLength;
      if (seen > limit) {
        throw new UploadRefused(
          413,
          `Upload exceeds ${Math.round(limit / 1024 / 1024)} MB limit`,
          { reason: "file_size_exceeded", size: seen },
        );
      }
      yield chunk;
    }
  }
  const iterator = counted()[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done) return;
  const rest = (async function* () {
    yield first.value;
    for (;;) {
      const next = await iterator.next();
      if (next.done) return;
      yield next.value;
    }
  })();
  const head = first.value;
  if (head.byteLength >= 2 && head[0] === 0x1f && head[1] === 0x8b) {
    const gunzip = Readable.from(rest).pipe(createGunzip());
    try {
      for await (const chunk of gunzip) yield chunk as Buffer;
    } catch (err) {
      if (err instanceof UploadRefused) throw err;
      throw new UploadRefused(422, "Uploaded file is not valid gzip", {
        reason: "invalid_gzip",
      });
    }
    return;
  }
  yield* rest;
}

export const POST = apiHandler(async (request: NextRequest) => {
  const { user: admin } = await requireAdmin();
  annotate({ action: { name: "admin.backups.upload" } });
  const ipAddress = getClientIp(request);

  // Rate-limit identical to the manual-run endpoint. Three is plenty for a
  // deliberate restore-prep workflow.
  const rl = await checkRateLimit(
    `admin-backups-upload:${admin.id}`,
    3,
    60 * 1000,
  );
  if (!rl.allowed) {
    throw new HttpError(429, "Too many backup uploads");
  }

  const denied = (reason: string, extra: Record<string, unknown> = {}) =>
    auditLog("admin.backups.upload.denied", {
      userId: admin.id,
      ipAddress,
      details: { reason, ...extra },
    });

  const contentType = request.headers.get("content-type") ?? "";
  const multipart = contentType.startsWith("multipart/form-data");
  const limit = multipart ? MAX_UPLOAD_BYTES : MAX_RAW_UPLOAD_BYTES;

  // Cheap pre-flight on the declared content length. The byte count while
  // reading is the hard limit; this just rejects obvious abuse early.
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > limit) {
    await denied("content_length_exceeded", { contentLength });
    return apiError(
      `Upload exceeds ${Math.round(limit / 1024 / 1024)} MB limit`,
      413,
    );
  }

  let source: AsyncIterable<Uint8Array>;
  if (multipart) {
    let formData: FormData;
    try {
      formData = await request.formData();
    } catch (err) {
      return apiError(
        `Invalid multipart body: ${err instanceof Error ? err.message : "unknown"}`,
        400,
      );
    }
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return apiError("Field 'file' must be a file", 422);
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      await denied("file_size_exceeded", { size: file.size });
      return apiError("Upload exceeds 10 MB limit", 413);
    }
    source = Readable.fromWeb(
      file.stream() as Parameters<typeof Readable.fromWeb>[0],
    );
  } else {
    if (!request.body) {
      return apiError("The backup file is missing from the request body", 422);
    }
    source = Readable.fromWeb(
      request.body as Parameters<typeof Readable.fromWeb>[0],
    );
  }

  // `MANUAL_UPLOAD_<unix-ms>` keeps the (userId, type) unique-constraint
  // intact so multiple uploads can coexist for the same user without
  // overwriting each other or the rolling WEEKLY_AUTO snapshot.
  const uploadType = `MANUAL_UPLOAD_${Date.now()}`;
  let payload: BackupPayload | undefined;
  let measurementCount = 0;
  let owner: { id: string; username: string } | null = null;

  let created: { id: string };
  try {
    created = await storeBackupBlob(
      prisma,
      {
        userId: admin.id,
        type: uploadType,
        ownerAfterRead: () => owner!.id,
      },
      async (write) => {
        // One pass: every chunk is stored as it is checked, and a check that
        // fails throws, which rolls the store back.
        async function* storedAsRead() {
          for await (const chunk of decodedBytes(source, limit)) {
            await write(Buffer.from(chunk));
            yield chunk;
          }
        }
        let firstWithoutId: number | null = null;
        let scanned;
        try {
          scanned = await scanBackupJson(storedAsRead(), {
            streamKeys: new Set(["measurements"]),
            onElement: (_key, element, index) => {
              const parsed = backupMeasurementSchema.safeParse(element);
              if (!parsed.success) {
                const issue = parsed.error.issues[0];
                throw new StreamedBackupInvalidError(
                  ["measurements", index, ...(issue?.path ?? [])].join("."),
                  issue?.message ?? "invalid measurement",
                );
              }
              if (!parsed.data.id && firstWithoutId === null) {
                firstWithoutId = index;
              }
            },
          });
        } catch (err) {
          if (err instanceof BackupJsonError) {
            throw new UploadRefused(422, "Uploaded file is not valid JSON", {
              reason: "invalid_json",
              message: err.message,
            });
          }
          if (err instanceof StreamedBackupInvalidError) {
            const issues = [{ path: err.path, message: err.message }];
            throw new UploadRefused(
              422,
              "Backup payload failed schema validation",
              { reason: "schema_invalid", issues },
              { issues },
            );
          }
          throw err;
        }
        measurementCount = scanned.streamedCounts.measurements ?? 0;

        try {
          payload = backupPayloadSchema.parse(scanned.document);
        } catch (err) {
          const issues =
            err instanceof ZodError
              ? err.issues.slice(0, 10).map((i) => ({
                  path: i.path.join("."),
                  message: i.message,
                }))
              : [];
          throw new UploadRefused(
            422,
            "Backup payload failed schema validation",
            { reason: "schema_invalid", issues },
            { issues },
          );
        }
        if (
          payload.schemaVersion === BACKUP_SCHEMA_VERSION &&
          firstWithoutId !== null
        ) {
          const issues = [
            {
              path: `measurements.${firstWithoutId}.id`,
              message: "Canonical v2 measurements require a stable id",
            },
          ];
          throw new UploadRefused(
            422,
            "Backup payload failed schema validation",
            { reason: "schema_invalid", issues },
            { issues },
          );
        }

        if (!isCompatibleSchemaVersion(payload.schemaVersion)) {
          throw new UploadRefused(
            422,
            `Backup schema version '${payload.schemaVersion}' is not supported by this server`,
            {
              reason: "incompatible_schema_version",
              schemaVersion: payload.schemaVersion,
            },
          );
        }

        // Make sure the userId on the file points at a user that exists in
        // this DB. Restore would fail later anyway, but failing here gives
        // the admin a precise error before any side-effect.
        owner = await prisma.user.findUnique({
          where: { id: payload.userId },
          select: { id: true, username: true },
        });
        if (!owner) {
          throw new UploadRefused(
            422,
            `Backup is for user '${payload.userId}' which does not exist in this DB`,
            { reason: "owner_not_found", ownerId: payload.userId },
          );
        }
      },
    );
  } catch (err) {
    if (err instanceof UploadRefused) {
      await denied(err.details.reason as string, err.details);
      return apiError(err.answer, err.status, err.meta);
    }
    // The file was fine; its encrypted copy is larger than the stored-copy
    // limit (`BACKUP_MAX_STORED_MB`). That is the operator's to act on, with
    // the numbers and the setting in the message, and not a server fault for
    // the error reporter. The store rolled back, so nothing was kept.
    if (err instanceof BackupBlobTooLargeError) {
      await denied("stored_copy_too_large", {
        bytes: err.bytes,
        limitBytes: err.limitBytes,
      });
      return apiError(
        `This backup is too large to store on this server. ${err.message}`,
        413,
        { errorCode: BACKUP_UPLOAD_TOO_LARGE_CODE },
      );
    }
    throw err;
  }

  const summary: BackupSummary = {
    ...summarizeBackup(payload!),
    measurements: measurementCount,
  };
  const storedOwner = owner as { id: string; username: string } | null;

  await auditLog("admin.backups.upload", {
    userId: admin.id,
    ipAddress,
    details: {
      backupId: created.id,
      ownerId: storedOwner?.id,
      ownerUsername: storedOwner?.username,
      type: uploadType,
      schemaVersion: summary.schemaVersion,
      counts: {
        measurements: summary.measurements,
        medications: summary.medications,
        intakeEvents: summary.intakeEvents,
        moodEntries: summary.moodEntries,
        cycles: summary.cycles,
        cycleDayLogs: summary.cycleDayLogs,
        labResults: summary.labResults,
        biomarkers: summary.biomarkers,
        illnessEpisodes: summary.illnessEpisodes,
        illnessDayLogs: summary.illnessDayLogs,
        allergies: summary.allergies,
        familyHistory: summary.familyHistory,
        workouts: summary.workouts,
        documents: summary.documents,
      },
    },
  });

  const response: UploadResponse = {
    id: created.id,
    valid: true,
    summary,
  };
  return apiSuccess(response, 201);
});
