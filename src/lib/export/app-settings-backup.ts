/**
 * The instance settings, the one section of a backup file that is not the
 * account's. Both backup ends in one file.
 *
 * A disaster-recovery payload carries the singleton `app_settings` row —
 * registration, the MFA requirement, the default locale and timezone, module
 * availability, the notification and AI configuration, the document size cap
 * and quota. Writing it back as a side effect of restoring ONE account
 * reconfigures the host for everybody on it, silently and hours or weeks out
 * of date: an operator putting a single record back on Wednesday has no
 * reason to expect Monday's registration switch and Monday's upload cap to
 * come with it. Putting the instance settings themselves back is a real
 * case, so the write stays available — as an answer the operator gives
 * (`restoreInstanceSettings`), not one the account restore assumes. An
 * account copy does not rebuild a lost host; a database dump and the keys do
 * (`docs/ops/disaster-recovery.md`).
 */
import { Prisma, type AppSettings } from "@/generated/prisma/client";
import {
  APP_SETTINGS_CARRIED_COLUMNS,
  APP_SETTINGS_COLUMNS,
} from "@/lib/export/app-settings-columns";
import type {
  BackupExportContext,
  BackupExportPart,
} from "@/lib/export/export-context";
import type { RestoreContext } from "@/lib/export/restore-context";
import { foldLegacyCoachAvailability } from "@/lib/modules/operator-availability";
import { forgetMfaPolicy } from "@/lib/auth/mfa-enrollment";

// ── Export ───────────────────────────────────────────────────────────────────

/** The carried columns of the row, made JSON-safe by each column's codec. */
export function serialiseAppSettings(
  row: AppSettings,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const column of APP_SETTINGS_CARRIED_COLUMNS) {
    const verdict = APP_SETTINGS_COLUMNS[column];
    if (verdict.class === "OPERATIONAL") continue;
    const value = row[column];
    out[column] =
      verdict.codec === "date"
        ? ((value as Date | null)?.toISOString() ?? null)
        : verdict.codec === "bigint"
          ? String(value)
          : value;
  }
  return out;
}

/**
 * The instance settings slice: the carried columns of the singleton row, in
 * a disaster-recovery payload only (`app-settings-columns.ts`).
 */
export async function buildAppSettingsBackupPart(
  ctx: BackupExportContext,
): Promise<BackupExportPart> {
  const appSettings = ctx.disasterRecovery
    ? await ctx.prisma.appSettings.findUnique({ where: { id: "singleton" } })
    : null;
  return {
    section: {
      appSettings:
        ctx.disasterRecovery && appSettings
          ? serialiseAppSettings(appSettings)
          : null,
    },
    counts: {},
  };
}

// ── Restore ──────────────────────────────────────────────────────────────────

/**
 * The row the file states, by the same table the export walked. A column the
 * file does not carry (a file older than the column) is written at its
 * default where the table names one, and left alone otherwise.
 */
export function appSettingsRowFromFile(
  settings: Record<string, unknown>,
): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const column of APP_SETTINGS_CARRIED_COLUMNS) {
    if (column === "id") continue;
    const verdict = APP_SETTINGS_COLUMNS[column];
    if (verdict.class === "OPERATIONAL") continue;
    let value = settings[column];
    if (value === undefined) {
      if (!("whenAbsent" in verdict)) continue;
      value = verdict.whenAbsent;
    }
    data[column] =
      verdict.codec === "date"
        ? value == null
          ? null
          : new Date(value as string)
        : verdict.codec === "bigint"
          ? BigInt(value as string)
          : verdict.codec === "json" && value === null
            ? Prisma.DbNull
            : value;
  }
  return data;
}

export async function restoreAppSettings(ctx: RestoreContext): Promise<void> {
  const { tx, payload } = ctx;
  if (!(payload.appSettings && ctx.restoreInstanceSettings)) return;
  const settings = payload.appSettings;
  // A file from before 0343 carries the Coach's operator answer in module
  // availability; carry it into the Coach switch.
  const coachFold = foldLegacyCoachAvailability(
    settings.moduleAvailabilityJson,
    settings.assistantCoachEnabled,
  );
  const row = appSettingsRowFromFile(settings);
  // The relay answer and the relay registration are one state in two places,
  // and only the answer travels. While this host is registered at a relay,
  // the registration is what sends (`routeFor`), so the host's own answer
  // stays: a file from before the switch would otherwise write `null` or
  // `off` beside a running relay, and the admin would be asked again, or
  // told it is off, while every push still goes over it.
  if (await hostIsRegisteredAtRelay(tx)) delete row.pushRelayDecision;
  const settingsData = {
    ...row,
    assistantCoachEnabled: coachFold.assistantCoachEnabled,
    moduleAvailabilityJson: coachFold.moduleAvailabilityJson,
  } as never;
  await tx.appSettings.upsert({
    where: { id: settings.id },
    create: { id: settings.id, ...(settingsData as object) },
    update: settingsData,
  });
  forgetMfaPolicy();
}

/**
 * A live registration on this host: one with an instance id that is not
 * being deleted (`loadRegistration`).
 */
async function hostIsRegisteredAtRelay(
  tx: RestoreContext["tx"],
): Promise<boolean> {
  const live = await tx.pushRelayRegistration.findFirst({
    where: { instanceId: { not: null }, state: { not: "deleting" } },
    select: { id: true },
  });
  return live !== null;
}
