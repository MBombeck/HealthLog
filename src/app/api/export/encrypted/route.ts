/**
 * POST /api/export/encrypted
 *
 * v1.23 — passphrase-encrypted variant of the full-backup export. Returns the
 * same payload as `GET /api/export/full-backup` (see that route's doc comment
 * for which domains restore recreates vs. export-only), sealed into an
 * `HLX1` archive (Argon2id-derived key + AES-256-GCM) under a passphrase the
 * caller supplies in the request body. The binary archive is returned as
 * `application/octet-stream`.
 *
 * SECURITY:
 *  - Fresh proof: `requireRecentProof`, the gate every whole-record export
 *    shares. A second factor within five minutes on an account that has one;
 *    otherwise a recent sign-in or a password re-proof.
 *  - The passphrase NEVER hits a log or wide-event: it is read off the parsed
 *    body, passed straight into the KDF, and never `annotate()`d. The egress
 *    redaction denylist already scrubs `/passphrase/i` (key-name) and the
 *    `passphrase=` query-string form as defence in depth.
 *  - There is NO server-side recovery — the passphrase is not stored. A
 *    forgotten passphrase means the archive is unrecoverable; the UI says so.
 *
 * Auth: cookie session with a recent proof; Bearer on the token alone for an
 * account without a second factor, with a second-factor `X-Step-Up`
 * elevation for one with.
 * Rate-limit: shared `export:<userId>` bucket (10/h) — same bucket as the
 * plaintext export so the encrypted variant cannot be used to bypass the cap.
 * Audit: `user.export.encrypted` with the row counts (never the passphrase).
 */
import { prisma } from "@/lib/db";
import { z } from "zod/v4";
import { apiHandler, requireRecentProof } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { apiError, getClientIp } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { checkRateLimit } from "@/lib/rate-limit";
import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FullBackupCounts } from "@/lib/export/full-backup-payload";
import { streamFullBackupJson } from "@/lib/export/full-backup-stream";
import {
  encryptArchiveToFile,
  MIN_EXPORT_PASSPHRASE_LENGTH,
  type SpooledArchive,
} from "@/lib/export/passphrase-archive";
import { streamToResponseBody } from "@/lib/export/response-stream";
import { NextRequest, NextResponse } from "next/server";

const SPOOL_PREFIX = "healthlog-export-";

/**
 * Remove spool files an earlier export left behind: a process that died
 * mid-export never reached its cleanup. An hour is far longer than any export
 * takes, so nothing still being written or sent is touched.
 */
async function removeStaleSpools(): Promise<void> {
  try {
    const dir = tmpdir();
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const name of await readdir(dir)) {
      if (!name.startsWith(SPOOL_PREFIX)) continue;
      const path = join(dir, name);
      const info = await stat(path).catch(() => null);
      if (info && info.mtimeMs < cutoff) await rm(path, { force: true });
    }
  } catch {
    // Housekeeping only; an export must not fail over it.
  }
}

const encryptedExportSchema = z
  .object({
    passphrase: z
      .string()
      .min(MIN_EXPORT_PASSPHRASE_LENGTH)
      // A generous upper bound — a passphrase, not a file. Keeps the KDF input
      // bounded.
      .max(1024),
  })
  .strict();

export const POST = apiHandler(async (request: NextRequest) => {
  // A fresh proof, like every whole-record export (`requireRecentProof`). On
  // the cookie path: a second factor within five minutes on an account that
  // has one, otherwise a recent sign-in or password re-proof. On Bearer the
  // shipped app calls this route without an elevation, so an account without
  // a second factor still passes on its token; one with a second factor
  // presents a second-factor elevation (before, it could not export at all).
  const auth = await requireRecentProof({ bearer: "elevation-if-enrolled" });
  const user = auth.user;
  annotate({ action: { name: "user.export.encrypted" } });

  const rl = await checkRateLimit(`export:${user.id}`, 10, 60 * 60 * 1000);
  if (!rl.allowed) {
    return apiError("Maximum 10 exports per hour", 429);
  }

  // The body is a single passphrase string — small and bounded. 8 KB is far
  // above any legitimate passphrase while rejecting a large body before parse.
  const parsed = await parseJsonBody(request, encryptedExportSchema, {
    maxBytes: 8 * 1024,
  });
  if (!parsed.ok) return parsed.error;
  const { passphrase } = parsed.data;
  await auth.commitElevation();

  // Sealed as it is produced and spooled to a temporary file, then sent: the
  // format puts the tag in front of the ciphertext, so the archive cannot go
  // out before its last byte is encrypted, and holding it in memory is what
  // took the app down on an account of 1.25 million measurements (#1031). Only
  // ciphertext touches the disk, and the file is removed once it is sent or
  // the client leaves.
  let counts: FullBackupCounts | undefined;
  await removeStaleSpools();
  const bodyPath = join(
    tmpdir(),
    `${SPOOL_PREFIX}${randomBytes(12).toString("hex")}.hlx.part`,
  );
  let archive: SpooledArchive;
  try {
    archive = await encryptArchiveToFile(
      async (write) => {
        counts = await streamFullBackupJson(prisma, user.id, write);
      },
      passphrase,
      bodyPath,
    );
  } catch (err) {
    await rm(bodyPath, { force: true });
    throw err;
  }

  await auditLog("user.export.encrypted", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { counts, format: "HLX1" },
  });

  annotate({
    meta: {
      export_measurements_count: counts?.measurements,
      export_medications_count: counts?.medications,
      export_intake_count: counts?.intakeEvents,
      export_mood_count: counts?.moodEntries,
      export_archive_bytes: archive.byteLength,
    },
  });

  const archiveBody = streamToResponseBody(
    async (write) => {
      await write(archive.prefix);
      for await (const chunk of createReadStream(archive.bodyPath)) {
        await write(chunk as Buffer);
      }
    },
    {
      onComplete: () => rm(archive.bodyPath, { force: true }),
      onError: () => rm(archive.bodyPath, { force: true }),
    },
  );

  // eslint-disable-next-line healthlog/no-utc-day-key -- UTC by design: file name stamp, not a day shown or compared
  const stamp = new Date().toISOString().slice(0, 10);
  // Return the raw binary archive (NOT the apiSuccess envelope). The file is a
  // self-contained `.hlx` archive openable with the user's passphrase via
  // scripts/decrypt-export.ts.
  return new NextResponse(archiveBody, {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(archive.byteLength),
      "Content-Disposition": `attachment; filename="healthlog-backup-${user.id}-${stamp}.hlx"`,
      "Cache-Control": "no-store",
    },
  });
});
