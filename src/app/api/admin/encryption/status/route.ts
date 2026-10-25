/**
 * GET /api/admin/encryption/status
 *
 * v1.23 — read-only admin view of encryption coverage + rotation progress.
 * Buckets every registered encrypted column's rows by key id (the same scan the
 * rotation tooling does), so an operator can SEE whether a rotation finished
 * before dropping a legacy key, instead of guessing.
 *
 * Returns ONLY key IDS (operator-chosen labels like `v1` / `v2`) and ROW
 * COUNTS — never key material. The configured-key set is surfaced as a count.
 *
 * Auth: cookie-only `requireAdmin` (a Bearer token can never reach admin). The
 * scan is on-demand with a short in-process cache so repeated panel renders
 * don't re-scan the corpus each time; the rotation run state is read from the
 * audit trail (DB-backed, so it is correct across the web/worker processes).
 */
import { prisma } from "@/lib/db";
import { apiHandler, requireAdmin } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { getConfiguredKeyIds } from "@/lib/crypto";
import { readBackupKeyNeeds } from "@/lib/recovery/backup-key-needs";
import {
  scanCorpus,
  type CorpusClient,
  type CorpusScan,
} from "@/lib/crypto/encryption-corpus";

const SCAN_CACHE_TTL_MS = 15_000;
let scanCache: { at: number; scan: CorpusScan } | null = null;

interface RotationState {
  state: "idle" | "running" | "completed" | "failed";
  lastRequestedAt: string | null;
  lastCompletedAt: string | null;
  lastResult: { scanned: number; rotated: number; errors: number } | null;
}

async function readRotationState(): Promise<RotationState> {
  const rows = await prisma.auditLog.findMany({
    where: {
      action: {
        in: [
          "admin.encryption.rotate.requested",
          "admin.encryption.rotate.completed",
          "admin.encryption.rotate.failed",
        ],
      },
    },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { action: true, createdAt: true, details: true },
  });

  const requested = rows.find(
    (r) => r.action === "admin.encryption.rotate.requested",
  );
  const finished = rows.find(
    (r) =>
      r.action === "admin.encryption.rotate.completed" ||
      r.action === "admin.encryption.rotate.failed",
  );

  let lastResult: RotationState["lastResult"] = null;
  if (
    finished?.action === "admin.encryption.rotate.completed" &&
    finished.details
  ) {
    try {
      const d = JSON.parse(finished.details) as {
        scanned?: number;
        rotated?: number;
        errors?: number;
      };
      lastResult = {
        scanned: d.scanned ?? 0,
        rotated: d.rotated ?? 0,
        errors: d.errors ?? 0,
      };
    } catch {
      lastResult = null;
    }
  }

  // "running" iff the most recent request is newer than the most recent
  // completion/failure.
  let state: RotationState["state"] = "idle";
  if (requested && (!finished || requested.createdAt > finished.createdAt)) {
    state = "running";
  } else if (finished?.action === "admin.encryption.rotate.completed") {
    state = "completed";
  } else if (finished?.action === "admin.encryption.rotate.failed") {
    state = "failed";
  }

  return {
    state,
    lastRequestedAt: requested?.createdAt.toISOString() ?? null,
    lastCompletedAt: finished?.createdAt.toISOString() ?? null,
    lastResult,
  };
}

export const GET = apiHandler(async () => {
  await requireAdmin();
  annotate({ action: { name: "admin.encryption.status" } });

  const now = Date.now();
  let scan: CorpusScan;
  if (scanCache && now - scanCache.at < SCAN_CACHE_TTL_MS) {
    scan = scanCache.scan;
  } else {
    scan = await scanCorpus(prisma as unknown as CorpusClient);
    scanCache = { at: now, scan };
  }

  const rotation = await readRotationState();
  const backups = await readBackupKeyNeeds(scan.activeKeyId, new Date());

  annotate({
    meta: {
      encryption_total_rows: scan.totalRows,
      encryption_stale_rows: scan.staleRows,
      encryption_rotation_complete: scan.rotationComplete,
    },
  });

  return apiSuccess({
    activeKeyId: scan.activeKeyId,
    // COUNT only — never the key material.
    configuredKeyCount: getConfiguredKeyIds().length,
    rotationComplete: scan.rotationComplete,
    totalRows: scan.totalRows,
    activeRows: scan.activeRows,
    staleRows: scan.staleRows,
    columns: scan.columns,
    rotation,
    backups,
    // Every row rotated AND no backup still needs a retired key: the one
    // state in which dropping an old key loses nothing. Copies that recorded
    // no key ids count against it, because they may hold any key that
    // existed when they were written.
    safeToDropRetiredKeys:
      scan.rotationComplete &&
      backups.retiredKeysStillNeeded.length === 0 &&
      backups.unrecorded.copies === 0,
  });
});
