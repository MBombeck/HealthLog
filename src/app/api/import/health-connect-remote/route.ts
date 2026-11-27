/**
 * `/api/import/health-connect-remote` — the WebDAV or Nextcloud folder a
 * scheduled Health Connect export lands in, fetched on its own.
 *
 *   GET    the folder and the last attempt; never the credentials.
 *   PUT    save the folder, the file name, the user name and (on first save,
 *          on a move to another server, or to change it) the password, which
 *          is sealed at rest. A private address needs its exact origin in
 *          `HEALTH_CONNECT_WEBDAV_PRIVATE_ORIGINS` (422 otherwise); a public
 *          one needs `https:`.
 *
 * The stored password only ever goes to the server it was given for. A save
 * that moves the folder to another origin without a new password is refused,
 * so the "never returned" credential cannot be pointed at a host the caller
 * picks and read back from its Basic header. A save that writes a password
 * asks for a fresh proof (`requireRecentProof`, a Bearer caller presents an
 * `X-Step-Up` elevation): it decides where a standing credential goes.
 *   DELETE forget the folder and its credentials.
 *
 * Owner-only (a cookie session or a full-scope token); the folder is the
 * account's own and a delegate never reaches it. The audit rows carry the
 * folder's origin and closed facts, never a credential.
 */
import type { NextRequest } from "next/server";

import { apiHandler, requireAuth, requireRecentProof } from "@/lib/api-handler";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { markDisconnected, markReconnected } from "@/lib/integrations/status";
import { sealCredentials } from "@/lib/import/health-connect/remote-fetch";
import {
  configuredWebdavPrivateOrigins,
  evaluateWebdavFolderUrl,
} from "@/lib/import/health-connect/remote-origin";
import { annotate } from "@/lib/logging/context";
import { originOfUrl } from "@/lib/private-origin-policy";
import { checkRateLimit } from "@/lib/rate-limit";
import { healthConnectRemoteSchema } from "@/lib/validations/health-connect-remote";

export const dynamic = "force-dynamic";

const SAVE_LIMIT = 10;
const SAVE_WINDOW_MS = 60 * 60 * 1000;

async function readState(userId: string) {
  const row = await prisma.healthConnectRemoteSource.findUnique({
    where: { userId },
    select: {
      folderUrl: true,
      fileName: true,
      enabled: true,
      lastAttemptAt: true,
      lastOutcome: true,
      nextAttemptAt: true,
      consecutiveFailures: true,
      lastImportJobId: true,
    },
  });
  return {
    source: row
      ? {
          folderUrl: row.folderUrl,
          fileName: row.fileName,
          enabled: row.enabled,
          lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
          lastOutcome: row.lastOutcome,
          nextAttemptAt: row.nextAttemptAt.toISOString(),
          consecutiveFailures: row.consecutiveFailures,
          lastImportJobId: row.lastImportJobId,
        }
      : null,
  };
}

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "import.health-connect.remote.get" } });
  return apiSuccess(await readState(user.id));
});

export const PUT = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "import.health-connect.remote.update" } });
  const rl = await checkRateLimit(
    `import:health-connect-remote:${user.id}`,
    SAVE_LIMIT,
    SAVE_WINDOW_MS,
  );
  if (!rl.allowed) return apiError("Too many changes, try again later", 429);

  const parsed = await parseJsonBody(request, healthConnectRemoteSchema, {
    maxBytes: 16 * 1024,
  });
  if (!parsed.ok) return parsed.error;
  const body = parsed.data;

  let target;
  try {
    target = evaluateWebdavFolderUrl(
      body.folderUrl,
      configuredWebdavPrivateOrigins(),
    );
  } catch {
    return apiError("The server's WebDAV origin list is malformed", 422, {
      errorCode: "import.health_connect.remote.origin_config_invalid",
    });
  }
  if (!target.allowed || !target.folderUrl) {
    if (target.reasonCode === "invalid_origin") {
      return apiError("This is not a usable folder address", 422, {
        errorCode: "import.health_connect.remote.invalid_url",
      });
    }
    if (target.reasonCode === "https_required") {
      return apiError("A public folder address must use https", 422, {
        errorCode: "import.health_connect.remote.https_required",
      });
    }
    return apiError("This folder address is on a private network", 422, {
      errorCode: "import.health_connect.remote.private_origin_not_approved",
    });
  }

  const existing = await prisma.healthConnectRemoteSource.findUnique({
    where: { userId: user.id },
    select: { id: true, folderUrl: true, fileName: true, enabled: true },
  });
  // The password belongs to the server it was given for: a first save, and a
  // save that moves the folder to another origin, bring their own.
  const originMoved =
    existing !== null && originOfUrl(existing.folderUrl) !== target.origin;
  if ((!existing || originMoved) && body.password === undefined) {
    return apiError("A password is required", 422, {
      errorCode: "import.health_connect.remote.password_required",
    });
  }
  const proof =
    body.password !== undefined
      ? await requireRecentProof({ bearer: "elevation", record: "owner" })
      : null;
  const moved =
    !existing ||
    existing.folderUrl !== target.folderUrl ||
    existing.fileName !== body.fileName;
  const credentials =
    body.password !== undefined
      ? sealCredentials({ username: body.username, password: body.password })
      : undefined;
  const now = new Date();
  await proof?.commitElevation();
  if (existing) {
    await prisma.healthConnectRemoteSource.update({
      where: { id: existing.id },
      data: {
        folderUrl: target.folderUrl,
        fileName: body.fileName,
        enabled: body.enabled,
        ...(credentials ? { credentialsEncrypted: credentials } : {}),
        // A new folder or file is read from scratch; new credentials or a
        // new address are tried at once, with the backoff reset.
        ...(moved ? { lastEtag: null } : {}),
        ...(moved || credentials
          ? { nextAttemptAt: now, consecutiveFailures: 0 }
          : {}),
      },
    });
  } else {
    await prisma.healthConnectRemoteSource.create({
      data: {
        userId: user.id,
        folderUrl: target.folderUrl,
        fileName: body.fileName,
        enabled: body.enabled,
        credentialsEncrypted: credentials!,
        nextAttemptAt: now,
      },
    });
  }
  // The shared ledger follows the source: a paused folder is disconnected,
  // and a new address or password starts a fresh streak, the way a
  // reconnect does for the other connections.
  if (!body.enabled) {
    await markDisconnected(user.id, "health-connect-remote");
  } else if (!existing || !existing.enabled || moved || credentials) {
    await markReconnected(user.id, "health-connect-remote");
  }
  await auditLog("import.health-connect.remote.update", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: {
      origin: target.origin,
      privateOrigin: target.privateOriginApproved,
      enabled: body.enabled,
      credentialsChanged: credentials !== undefined,
    },
  });
  return apiSuccess(await readState(user.id));
});

export const DELETE = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "import.health-connect.remote.delete" } });
  const { count } = await prisma.healthConnectRemoteSource.deleteMany({
    where: { userId: user.id },
  });
  if (count > 0) {
    await markDisconnected(user.id, "health-connect-remote");
    await auditLog("import.health-connect.remote.delete", {
      userId: user.id,
      ipAddress: getClientIp(request),
    });
  }
  return apiSuccess({ deleted: count > 0 });
});
