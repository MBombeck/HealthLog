/**
 * The operator's settings that every app boot reads, in one statement per
 * request.
 *
 * `/api/auth/me` resolved six answers out of the `AppSettings` singleton (the
 * MFA policy, the Assistant switches, the module availability, the provider
 * presence, the AI usage bounds and the reasoning controls), each with its own
 * `SELECT` of a few columns, so one client boot read the same row six times.
 * Each reader (the push relay's operator decision among them) now takes its
 * columns from this one read, memoised for the request (and read afresh for
 * every call inside a background job, whose one event spans a whole
 * multi-user pass, like the readers it serves).
 *
 * A reader keeps its own error handling: a failed read rejects here, and the
 * memo forgets a rejected read so the next caller tries again.
 */
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { memoizePerRequest } from "@/lib/request-cache";

export const OPERATOR_ROW_SELECT = {
  mfaRequired: true,
  mfaRequiredForAdmins: true,
  mfaGraceDays: true,
  mfaPolicySince: true,
  assistantEnabled: true,
  assistantCoachEnabled: true,
  assistantBriefingEnabled: true,
  assistantInsightStatusEnabled: true,
  assistantDocumentAiEnabled: true,
  moduleAvailabilityJson: true,
  adminAiKeyEncrypted: true,
  adminAiModel: true,
  adminAiBaseUrl: true,
  adminCodexConnectionStatus: true,
  adminCodexAccessTokenEncrypted: true,
  adminCodexRefreshTokenEncrypted: true,
  adminCodexAccountIdEncrypted: true,
  aiUsageMaxLevel: true,
  aiUsageDefaultLevel: true,
  aiSyncRegenGapHours: true,
  aiReasoningEnabled: true,
  aiReasoningMaxEffort: true,
  pushRelayDecision: true,
  telegramGlobal: true,
  ntfyGlobal: true,
  webPushGlobal: true,
  apiGlobal: true,
} as const satisfies Prisma.AppSettingsSelect;

export type OperatorRow = Prisma.AppSettingsGetPayload<{
  select: typeof OPERATOR_ROW_SELECT;
}>;

export function readOperatorRow(): Promise<OperatorRow | null> {
  return memoizePerRequest(
    "operator-settings-row",
    () =>
      prisma.appSettings.findUnique({
        where: { id: "singleton" },
        select: OPERATOR_ROW_SELECT,
      }),
    { freshInBackground: true },
  );
}

/**
 * Presence-only check that the operator's central Codex is connected, over an
 * already-loaded `AppSettings` subset. No decrypt, no network.
 */
export function appSettingsCentralCodexConnected(
  settings: {
    adminCodexConnectionStatus: string | null;
    adminCodexAccessTokenEncrypted: string | null;
    adminCodexRefreshTokenEncrypted: string | null;
    adminCodexAccountIdEncrypted: string | null;
  } | null,
): boolean {
  return (
    settings?.adminCodexConnectionStatus === "connected" &&
    !!settings.adminCodexAccessTokenEncrypted &&
    !!settings.adminCodexRefreshTokenEncrypted &&
    !!settings.adminCodexAccountIdEncrypted
  );
}
