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
 *      of type `MANUAL_UPLOAD_<unix-ms>` (`RETARGETED_UPLOAD_<unix-ms>` for
 *      a copy put into a chosen account, `backup-upload-type.ts`) so
 *      multiple uploads coexist with the rolling `WEEKLY_AUTO` snapshot AND
 *      with each other.
 *
 * The file is read as a stream and never held whole (#1031): an export of an
 * account with 1.25 million measurements is a few hundred megabytes of JSON,
 * which neither fits a 1 GB container beside the running app nor, in the
 * disaster-recovery shape, fits in one JavaScript string at all. It is
 * checked as it goes and stored in the same pass; a file that fails any check
 * rolls the store back, so nothing of it remains.
 *
 * The file names the account it belongs to, and that account has to exist
 * here. When it does not (the account was erased, and the operator still has
 * its disaster-recovery file), the upload answers 422 with
 * `backup.owner.missing`, and the operator can send the file again with a
 * target in the query (`backup-upload-target.ts`): an existing account that
 * holds no records yet, confirmed by typing its username, or a new account
 * created for the copy. The file's owner is then rewritten to that account as
 * the bytes come in (`backup-owner-rewrite.ts`), so the copy stored is that
 * account's copy, and the restore that follows is the ordinary one. The new
 * account has no password; an admin sets its first one in Admin, Users.
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

import { BodyTooLargeError, readBoundedBody } from "@/lib/labs/ocr-upload";
import { NextRequest } from "next/server";
import { Prisma } from "@/generated/prisma/client";
import { ZodError } from "zod/v4";
import { prisma } from "@/lib/db";
import {
  apiHandler,
  HttpError,
  requireAdmin,
  assertRecentCookieProof,
} from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  getClientIp,
  returnAllZodIssues,
} from "@/lib/api-response";
import { auditLog } from "@/lib/auth/audit";
import { BackupJsonError } from "@/lib/export/backup-json-scan";
import {
  BackupOwnerRewriteError,
  rewriteBackupOwner,
  type BackupOwnerRewrite,
} from "@/lib/export/backup-owner-rewrite";
import {
  BackupUploadDecodeError,
  decodeBackupUpload,
} from "@/lib/export/backup-upload-decode";
import {
  assessBackupKeys,
  BACKUP_KEY_MISSING_CODE,
  BackupKeyIdCollector,
  describeBackupKeyProblem,
} from "@/lib/export/backup-key-ids";
import {
  BACKUP_UPLOAD_TOO_LARGE_CODE,
  BackupBlobTooLargeError,
} from "@/lib/export/backup-blob";
import {
  checkRestoreTarget,
  RESTORE_TARGET_REFUSALS,
  type RestoreTargetVerdict,
} from "@/lib/export/restore-target";
import { storeBackupBlob } from "@/lib/export/store-backup-blob";
import { uploadedBackupType } from "@/lib/export/backup-upload-type";
import {
  readStreamedBackup,
  StreamedBackupInvalidError,
  type StreamedBackup,
} from "@/lib/export/streamed-backup";
import { annotate } from "@/lib/logging/context";
import { checkRateLimit } from "@/lib/rate-limit";
import type { BackupPayload } from "@/lib/validations/backup";
import {
  BACKUP_OWNER_EXISTS_CODE,
  BACKUP_OWNER_MISSING_CODE,
  BACKUP_TARGET_UNCONFIRMED_CODE,
  BACKUP_TARGET_USERNAME_TAKEN_CODE,
  parseBackupUploadTarget,
  type BackupUploadTarget,
} from "@/lib/validations/backup-upload-target";
import {
  isCompatibleSchemaVersion,
  summarizeBackup,
  type BackupSummary,
} from "@/lib/validations/backup-summary";

export const dynamic = "force-dynamic";

/**
 * Cap on a file sent as a multipart form. The form parser holds the whole
 * file in memory, so this path stays for small files only; anything larger
 * is sent as the raw request body, which is read as a stream.
 */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** Room for the multipart boundaries and part headers around the file. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

/**
 * Cap on a file sent as the raw request body, compressed or not, counted
 * while the body streams. The route is left out of the proxy matcher
 * (`src/lib/http/proxy-bypass-routes.ts`), so this is the only ceiling. A
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

/** The answer and audit details for a target the copy may not go into. */
function targetRefused(
  verdict: Extract<RestoreTargetVerdict, { ok: false }>,
  userId: string,
): UploadRefused {
  const refusal = RESTORE_TARGET_REFUSALS[verdict.reason];
  const models = verdict.models.length > 0 ? { models: verdict.models } : {};
  return new UploadRefused(
    refusal.status,
    refusal.message,
    { reason: `target_${verdict.reason}`, targetUserId: userId, ...models },
    { errorCode: refusal.code, ...models },
  );
}

/** The file's bytes, gunzipped and counted on both ends. */
async function* decodedBytes(
  source: AsyncIterable<Uint8Array>,
  limit: number,
): AsyncGenerator<Uint8Array> {
  try {
    yield* decodeBackupUpload(source, { compressedLimit: limit });
  } catch (err) {
    if (err instanceof BackupUploadDecodeError) {
      throw new UploadRefused(err.status, err.message, {
        reason: err.reason,
        ...(err.size !== undefined ? { size: err.size } : {}),
      });
    }
    throw err;
  }
}

/** A file's read failure as the refusal the operator sees. */
function schemaRefusal(issues: Array<{ path: string; message: string }>) {
  return new UploadRefused(
    422,
    "Backup payload failed schema validation",
    { reason: "schema_invalid", issues },
    { issues },
  );
}

/**
 * Read the file through the one streamed reader every backup reader shares
 * (`streamed-backup.ts`): the bulk sections an element at a time and the
 * documents without their stored bytes, so a document vault of hundreds of
 * megabytes is never in memory at once (#1239). It checks each measurement
 * and the canonical v2 id rule as it goes, and gathers the key ids the file's
 * inner ciphertext needs.
 */
async function readUploadedFile(
  source: () => AsyncIterable<Uint8Array>,
): Promise<StreamedBackup> {
  try {
    return await readStreamedBackup(source);
  } catch (err) {
    if (err instanceof BackupJsonError) {
      throw new UploadRefused(422, "Uploaded file is not valid JSON", {
        reason: "invalid_json",
        message: err.message,
      });
    }
    if (err instanceof BackupOwnerRewriteError) {
      throw schemaRefusal([{ path: "userId", message: err.message }]);
    }
    if (err instanceof StreamedBackupInvalidError) {
      throw schemaRefusal([{ path: err.path, message: err.message }]);
    }
    throw err;
  }
}

/** The file against the backup schema, and its version against this server. */
async function parseUploadedPayload(raw: unknown): Promise<BackupPayload> {
  // Loaded on first use, not at import (see `backup-summary.ts`).
  const { backupPayloadSchema } = await import("@/lib/validations/backup");
  let payload: BackupPayload;
  try {
    payload = backupPayloadSchema.parse(raw);
  } catch (err) {
    throw schemaRefusal(
      err instanceof ZodError
        ? err.issues.slice(0, 10).map((i) => ({
            path: i.path.join("."),
            message: i.message,
          }))
        : [],
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
  return payload;
}

type ChosenTarget = { id: string; username: string; created: boolean };

const usernameTaken = () =>
  new UploadRefused(
    409,
    "That username is already taken.",
    { reason: "target_username_taken" },
    { errorCode: BACKUP_TARGET_USERNAME_TAKEN_CODE },
  );

/**
 * The target the query names, checked before a byte of the file is read, so
 * a target that will be refused costs no upload. An existing account is
 * checked whole and confirmed by its username; a new one only for its
 * username, since it is created once the request is otherwise admissible.
 */
async function checkTargetBeforeRead(
  choice: BackupUploadTarget | null,
): Promise<ChosenTarget | null> {
  if (choice?.into === "existing") {
    const verdict = await checkRestoreTarget(prisma, choice.userId);
    if (!verdict.ok) throw targetRefused(verdict, choice.userId);
    // The restore writes into this account, so the operator names it.
    if (choice.confirm.trim() !== verdict.target.username) {
      throw new UploadRefused(
        422,
        "Type the chosen account's username to confirm. Nothing was stored.",
        { reason: "target_unconfirmed", targetUserId: choice.userId },
        { errorCode: BACKUP_TARGET_UNCONFIRMED_CODE },
      );
    }
    return { ...verdict.target, created: false };
  }
  if (choice?.into === "new") {
    const taken = await prisma.user.findUnique({
      where: { username: choice.username },
      select: { id: true },
    });
    if (taken) throw usernameTaken();
  }
  return null;
}

/** Who made an account for a copy, for the trail. */
interface UploadActor {
  adminId: string;
  ipAddress: string | null;
}

/**
 * The account made for a copy. Created before the file is read, because the
 * file is rewritten to its id on the way in, and deleted again when nothing
 * is stored. No password, no email: nobody can sign into it until an admin
 * sets its first password (Admin, Users, Reset password). Its audit row
 * commits with it, so an account this route made always has a trace, even
 * when the upload fails and removing it again fails too.
 */
async function createTargetAccount(
  username: string,
  actor: UploadActor,
): Promise<ChosenTarget> {
  try {
    const account = await prisma.$transaction(async (tx) => {
      const row = await tx.user.create({
        data: { username, role: "USER" },
        select: { id: true, username: true },
      });
      await auditLog("admin.user.create", {
        userId: actor.adminId,
        ipAddress: actor.ipAddress,
        client: tx,
        details: {
          targetUserId: row.id,
          username: row.username,
          reason: "backup_restore",
          outcome: "created",
        },
      });
      return row;
    });
    return { ...account, created: true };
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      throw usernameTaken();
    }
    throw err;
  }
}

/**
 * Whose copy a file sent with a target becomes, once it has been read. The
 * file now names the chosen account; the account it named before has to be
 * gone, because the copy of an account that is still here restores into that
 * account and never into another one. An existing target is checked again:
 * the file took a while to read, and the account may have changed meanwhile.
 */
async function ownerOfRetargetedFile(
  chosen: ChosenTarget,
  rewrite: BackupOwnerRewrite | null,
): Promise<{ id: string; username: string }> {
  const declared = rewrite?.declaredOwner() ?? null;
  const declaredOwner = declared
    ? await prisma.user.findUnique({
        where: { id: declared },
        select: { id: true },
      })
    : null;
  if (!declared || declaredOwner) {
    throw new UploadRefused(
      409,
      "This file belongs to an account on this server and restores into that account. Upload it without choosing an account.",
      { reason: "owner_exists", ownerId: declared },
      { errorCode: BACKUP_OWNER_EXISTS_CODE },
    );
  }
  if (!chosen.created) {
    const again = await checkRestoreTarget(prisma, chosen.id);
    if (!again.ok) throw targetRefused(again, chosen.id);
  }
  return { id: chosen.id, username: chosen.username };
}

/**
 * Delete the account an upload created for its copy, when nothing was stored.
 * It holds nothing and nobody can have signed into it (no password, no email),
 * so the row is all there is. Either way the trail says what became of it: a
 * removal that failed leaves an account to delete by hand
 * (`docs/ops/backup-restore.md`). A failure is noted, never thrown over the
 * refusal the operator needs to see.
 */
async function discardCreatedAccount(
  account: ChosenTarget,
  actor: UploadActor,
): Promise<void> {
  let outcome: "deleted" | "failed" = "deleted";
  try {
    await prisma.user.delete({ where: { id: account.id } });
  } catch (err) {
    outcome = "failed";
    annotate({
      meta: {
        backup_upload_account_discard_failed: true,
        backup_upload_account_discard_error:
          err instanceof Error ? err.message : String(err),
      },
    });
  }
  try {
    await auditLog("admin.user.delete", {
      userId: actor.adminId,
      ipAddress: actor.ipAddress,
      details: {
        targetUserId: account.id,
        username: account.username,
        reason: "backup_upload_refused",
        outcome,
      },
    });
  } catch {
    annotate({ meta: { backup_upload_account_discard_unaudited: true } });
  }
}

export const POST = apiHandler(async (request: NextRequest) => {
  const { user: admin, session } = await requireAdmin();
  // A fresh proof on top of the admin session: this reaches every account's
  // data, so a stolen admin session alone must not be enough.
  await assertRecentCookieProof(admin, session.id);
  annotate({ action: { name: "admin.backups.upload" } });
  const ipAddress = getClientIp(request);
  const actor: UploadActor = { adminId: admin.id, ipAddress };

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
  const refuse = async (err: UploadRefused) => {
    await denied(err.details.reason as string, err.details);
    return apiError(err.answer, err.status, err.meta);
  };

  // The account the copy goes into when the file's own account is gone.
  const parsedTarget = parseBackupUploadTarget(
    new URL(request.url).searchParams,
  );
  if (!parsedTarget.success) {
    await denied("target_invalid");
    return returnAllZodIssues(parsedTarget.error);
  }
  const choice = parsedTarget.data;
  let target: ChosenTarget | null;
  try {
    target = await checkTargetBeforeRead(choice);
  } catch (err) {
    if (err instanceof UploadRefused) return refuse(err);
    throw err;
  }
  annotate({ meta: { backup_upload_into: choice?.into ?? "owner" } });

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
    // The multipart parser holds the whole form and counts nothing, so the
    // bytes are counted first and the form is parsed from what was kept. The
    // route is outside the proxy matcher, so nothing else bounds this read.
    let formData: FormData;
    try {
      const bytes = await readBoundedBody(
        request.body,
        MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD_BYTES,
      );
      formData = await new Response(new Blob([bytes]), {
        headers: { "content-type": contentType },
      }).formData();
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        await denied("stream_size_exceeded");
        return apiError("Upload exceeds 10 MB limit", 413);
      }
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

  // The millisecond suffix keeps uploads and WEEKLY_AUTO apart under the
  // (userId, type) unique constraint; a copy put into a chosen account is
  // marked as such, for its restore (`backup-upload-type.ts`).
  const uploadType = uploadedBackupType(Boolean(choice), Date.now());
  let payload: BackupPayload | undefined;
  let measurementCount = 0;
  let owner: { id: string; username: string } | null = null;

  // Filled once the file is read; the preview is the summary this route
  // answers with and the key uses it already holds (`backup-preview.ts`).
  let keys: BackupKeyIdCollector | undefined;
  let created: { id: string };
  let rewrite: BackupOwnerRewrite | null = null;
  if (choice?.into === "new") {
    try {
      target = await createTargetAccount(choice.username, actor);
    } catch (err) {
      if (err instanceof UploadRefused) return refuse(err);
      throw err;
    }
  }
  const chosen = target;
  try {
    created = await storeBackupBlob(
      prisma,
      {
        userId: admin.id,
        type: uploadType,
        ownerAfterRead: () => owner!.id,
        preview: () =>
          payload && keys
            ? {
                summary: {
                  ...summarizeBackup(payload),
                  measurements: measurementCount,
                },
                keys,
              }
            : null,
      },
      async (write) => {
        // One pass: every chunk is stored as it is checked, and a check that
        // fails throws, which rolls the store back.
        const decoded = decodedBytes(source, limit);
        if (chosen) rewrite = rewriteBackupOwner(decoded, chosen.id);
        async function* storedAsRead() {
          for await (const chunk of rewrite ? rewrite.bytes : decoded) {
            await write(Buffer.from(chunk));
            yield chunk;
          }
        }
        const streamed = await readUploadedFile(storedAsRead);
        measurementCount = streamed.measurementCount;
        payload = await parseUploadedPayload(streamed.raw);

        // A file whose inner ciphertext needs a key this host does not have
        // can be stored but never restored: the restore would refuse it, or
        // worse, a restore on a host that had lost the key would write rows
        // nobody can open. Refused here, where the operator is looking, with
        // the key named. The instance settings are left to the restore, which
        // checks them only when they are asked for back.
        keys = streamed.keys;
        const keyVerdict = assessBackupKeys(keys, {
          ignoreSections: new Set(["appSettings"]),
        });
        const keyProblem = describeBackupKeyProblem(keyVerdict);
        if (keyProblem) {
          const keyIds = [...keyVerdict.missing, ...keyVerdict.unreadable];
          throw new UploadRefused(
            422,
            keyProblem,
            { reason: "key_missing", keyIds },
            { errorCode: BACKUP_KEY_MISSING_CODE, keyIds },
          );
        }

        if (chosen) {
          owner = await ownerOfRetargetedFile(chosen, rewrite);
          return;
        }

        // Make sure the userId on the file points at a user that exists in
        // this DB. Restore would fail later anyway, but failing here gives
        // the admin a precise error before any side-effect.
        owner = await prisma.user.findUnique({
          where: { id: payload.userId },
          select: { id: true, username: true },
        });
        if (!owner) {
          // Most often an account that was erased. Its id is not written
          // into the trail: the erasure took every row that named it, and a
          // refused upload is not a reason to bring it back. The answer says
          // what the operator can do instead.
          throw new UploadRefused(
            422,
            "This file belongs to an account that does not exist on this server. Choose an account to restore it into.",
            { reason: "owner_not_found" },
            { errorCode: BACKUP_OWNER_MISSING_CODE },
          );
        }
      },
    );
  } catch (err) {
    // Nothing was stored, so the account made for the copy goes again.
    if (chosen?.created) await discardCreatedAccount(chosen, actor);
    if (err instanceof UploadRefused) return refuse(err);
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
      // Set when the copy went into a chosen account; the erased id is not.
      ...(chosen ? { into: chosen.created ? "new" : "existing" } : {}),
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
