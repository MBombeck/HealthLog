/**
 * 1.49 — reading and writing the server setup state (see `./server-setup.ts`).
 *
 * Admin-only by its callers: every route that reaches this runs
 * `requireAdmin()`, which is cookie-only, so a Bearer token or a delegate never
 * reads or writes it.
 */
import { prisma, toJson } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { withAppSettingsRowLock } from "@/lib/app-settings-row-lock";
import { isOidcConfigured, isOidcOnly } from "@/lib/auth/oidc";
import { isEmailConfigured } from "@/lib/notifications/senders/email-config";
import { accountPushState } from "@/lib/push-relay/capability";

import {
  applyServerSetupStep,
  everyServerSetupStepSettled,
  parseServerSetupSteps,
  SERVER_SETUP_NOTICE_ID,
  type ServerSetupFacts,
  type ServerSetupState,
  type ServerSetupStepId,
} from "./server-setup";

const SINGLETON = "singleton";

/** The required SMTP variables, by name. */
const SMTP_REQUIRED = ["SMTP_HOST", "SMTP_PORT", "SMTP_FROM"] as const;

/** A demo deploy never offers the setup (its account is shared). */
export function serverSetupOfferedHere(): boolean {
  return process.env.DEMO_MODE !== "true";
}

export function readServerSetupFacts(
  env: Record<string, string | undefined> = process.env,
): ServerSetupFacts {
  const set = (name: string) => (env[name] ?? "").trim().length > 0;
  return {
    oidc: { configured: isOidcConfigured(), only: isOidcOnly() },
    smtp: {
      configured: isEmailConfigured(),
      missing: SMTP_REQUIRED.filter((name) => !set(name)),
    },
    telegram: { webhookSecret: set("TELEGRAM_WEBHOOK_SECRET") },
  };
}

async function readRow(
  db: Pick<Prisma.TransactionClient, "appSettings"> = prisma,
) {
  return db.appSettings.findUnique({
    where: { id: SINGLETON },
    select: { serverSetupCompletedAt: true, serverSetupStepsJson: true },
  });
}

export async function readServerSetupState(
  adminUserId: string,
): Promise<ServerSetupState> {
  const [row, admin, push] = await Promise.all([
    readRow(),
    prisma.user.findUnique({
      where: { id: adminUserId },
      select: { adminNoticesDismissed: true },
    }),
    accountPushState(adminUserId, undefined, { isAdmin: true }),
  ]);
  const offered = serverSetupOfferedHere();
  const completedAt = row?.serverSetupCompletedAt?.toISOString() ?? null;
  // The relay question lives on the admin start page; an admin who never
  // opens it learns of an open question from this notice, which an upgraded
  // server (setup stamped finished) would otherwise never show.
  const relayUndecided =
    push.relay.canDecide && push.relay.operatorDecision === "undecided";
  return {
    offered,
    completedAt,
    steps: parseServerSetupSteps(row?.serverSetupStepsJson ?? null),
    noticePending:
      offered &&
      (completedAt === null || relayUndecided) &&
      !(admin?.adminNoticesDismissed ?? []).includes(SERVER_SETUP_NOTICE_ID),
    facts: readServerSetupFacts(),
  };
}

/**
 * Record one step. When every step is settled the setup is stamped finished,
 * once: a later pass through a step keeps the first stamp.
 */
export async function writeServerSetupStep(
  id: ServerSetupStepId,
  status: "done" | "skipped",
  now: Date = new Date(),
): Promise<void> {
  // The steps are one document, read and written back whole, so two steps
  // settled at the same moment are written under the settings row's lock.
  await withAppSettingsRowLock(async (tx) => {
    const row = await readRow(tx);
    const steps = applyServerSetupStep(
      parseServerSetupSteps(row?.serverSetupStepsJson ?? null),
      id,
      status,
    );
    const completedAt =
      row?.serverSetupCompletedAt ??
      (everyServerSetupStepSettled(steps) ? now : null);
    await tx.appSettings.upsert({
      where: { id: SINGLETON },
      create: {
        id: SINGLETON,
        serverSetupStepsJson: toJson(steps),
        serverSetupCompletedAt: completedAt,
      },
      update: {
        serverSetupStepsJson: toJson(steps),
        serverSetupCompletedAt: completedAt,
      },
    });
  });
}

/** Hide the start-page notice for this admin. Idempotent. */
export async function dismissServerSetupNotice(
  adminUserId: string,
): Promise<void> {
  const row = await prisma.user.findUnique({
    where: { id: adminUserId },
    select: { adminNoticesDismissed: true },
  });
  if (!(row?.adminNoticesDismissed ?? []).includes(SERVER_SETUP_NOTICE_ID)) {
    await prisma.user.update({
      where: { id: adminUserId },
      data: { adminNoticesDismissed: { push: SERVER_SETUP_NOTICE_ID } },
    });
  }
}

/**
 * Whether a person flow screen should point an admin at the server setup:
 * an admin, on a server that offers it, whose setup is not finished.
 */
export async function serverSetupOpenFor(user: {
  role: string;
}): Promise<boolean> {
  if (user.role !== "ADMIN" || !serverSetupOfferedHere()) return false;
  const row = await readRow();
  return row?.serverSetupCompletedAt == null;
}
