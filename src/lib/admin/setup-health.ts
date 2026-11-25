/**
 * 1.49 — reading the setup health's inputs from the environment and the
 * request (`./setup-health-model.ts` decides). Admin-only by its one caller,
 * `GET /api/admin/setup-health`.
 *
 * Nothing secret leaves here: key ids and counts (never key material), the
 * configured public URL (already public), whether the flag is set.
 */
import { getActiveKeyId, getConfiguredKeyIds } from "@/lib/crypto";
import { shouldEmitSecureCookie } from "@/lib/auth/secure-cookie";
import {
  backupDirectoryStatus,
  databaseBackupEnabled,
  resolveBackupDir,
  resolveBackupSchedule,
} from "@/lib/database-backup/dump-core.mjs";
import { resolveRequestOrigin } from "@/lib/http/origin";

import {
  evaluateSetupHealth,
  type SetupHealth,
  type SetupHealthInputs,
} from "./setup-health-model";

function safely<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

export function readSetupHealthInputs(
  request: Request,
  env: Record<string, string | undefined> = process.env,
): SetupHealthInputs {
  const resolved = safely(() => resolveRequestOrigin(request, env), null);
  const appUrl =
    (env.NEXT_PUBLIC_APP_URL ?? "").trim() || (env.APP_URL ?? "").trim();
  const enabled = databaseBackupEnabled(env);
  return {
    encryption: {
      configuredKeys: safely(() => getConfiguredKeyIds().length, 0),
      activeKeyId: safely(() => getActiveKeyId(), null),
    },
    secureCookie: shouldEmitSecureCookie(),
    requestProtocol: resolved?.protocol ?? null,
    requestProtocolFrom: resolved?.protocolFrom ?? null,
    appUrl: appUrl || null,
    requestOrigin: resolved?.origin ?? null,
    backups: {
      enabled,
      persistent: enabled
        ? safely(
            () => backupDirectoryStatus(resolveBackupDir(env)).persistent,
            false,
          )
        : false,
      cron: resolveBackupSchedule(env).cron,
    },
  };
}

export function readSetupHealth(request: Request): SetupHealth {
  return evaluateSetupHealth(readSetupHealthInputs(request));
}
