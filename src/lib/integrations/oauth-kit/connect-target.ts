/**
 * Whose record an OAuth connect lands on, and who is allowed to finish it.
 *
 * A guardian connects a provider for a managed profile they manage: the
 * connect route resolves through `requireGuardianAuth`, so its `user` is the
 * profile and its `actor` the guardian, and the state it mints names the
 * profile. Tokens and data land on the profile. The state never carries a
 * record selector the browser could change: it is signed, or a server-side
 * ledger row, and it names exactly one record.
 *
 * The callback then has to answer one question the connect could not: is the
 * browser completing this flow allowed to attach a provider account to that
 * record? For a person's own record the answer is unchanged (their session, or
 * no session at all on the flows that allow one). For a managed profile, which
 * has no login of its own, the browser must hold a session of a guardian with
 * a live MANAGE grant on the profile, checked again here because ten minutes
 * can pass on a consent screen and a grant can be revoked in them.
 */
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { auditLog } from "@/lib/auth/audit";
import { findActiveGrant, grantAllows } from "@/lib/sharing/grant-access";
import type { OAuthKitProvider } from "./token";

export type CallbackActorVerdict =
  | {
      readonly ok: true;
      /** The guardian who finished it, or null for the record's own browser. */
      readonly guardianUserId: string | null;
    }
  | {
      readonly ok: false;
      readonly reason: "cross_user" | "guardian_session_required";
    };

/**
 * May the session `sessionUserId` (null: no session) finish a connect whose
 * state names `recordUserId`? On success, which guardian acted, if one did.
 */
export async function verifyCallbackActor(
  recordUserId: string,
  sessionUserId: string | null,
): Promise<CallbackActorVerdict> {
  if (sessionUserId === recordUserId) {
    return { ok: true, guardianUserId: null };
  }
  const record = await prisma.user.findUnique({
    where: { id: recordUserId },
    select: { managedProfileAt: true },
  });
  if (!record) return { ok: false, reason: "cross_user" };
  if (record.managedProfileAt === null) {
    // An ordinary account: its own browser without a session may finish (the
    // native flows), anybody else's session may not.
    return sessionUserId === null
      ? { ok: true, guardianUserId: null }
      : { ok: false, reason: "cross_user" };
  }
  if (sessionUserId === null) {
    return { ok: false, reason: "guardian_session_required" };
  }
  const grant = await findActiveGrant({
    grantorId: recordUserId,
    granteeId: sessionUserId,
  });
  if (!grant || !grantAllows(grant, "manage")) {
    return { ok: false, reason: "cross_user" };
  }
  return { ok: true, guardianUserId: sessionUserId };
}

/** The per-user columns holding a provider's own OAuth app. */
const CLIENT_COLUMNS = {
  withings: ["withingsClientIdEncrypted", "withingsClientSecretEncrypted"],
  whoop: ["whoopClientIdEncrypted", "whoopClientSecretEncrypted"],
  oura: ["ouraClientIdEncrypted", "ouraClientSecretEncrypted"],
  strava: ["stravaClientIdEncrypted", "stravaClientSecretEncrypted"],
  "google-health": [
    "googleHealthClientIdEncrypted",
    "googleHealthClientSecretEncrypted",
  ],
  polar: ["polarClientIdEncrypted", "polarClientSecretEncrypted"],
} as const satisfies Record<OAuthKitProvider, readonly [string, string]>;

/**
 * Let a managed profile connect with its guardian's own provider app.
 *
 * Every provider here is bring-your-own-app: the client id and secret sit on
 * the account that connects, and the background refresh reads them from that
 * account. A managed profile never had a settings page to paste them into, so
 * when it has no app of its own and the deployment has no shared one, the
 * guardian's app is copied onto the profile, still sealed, with an audit row
 * on the profile naming the guardian. Does nothing for a person's own connect, and nothing when
 * the profile can already resolve an app.
 */
export async function shareGuardianClientApp(
  provider: OAuthKitProvider,
  target: { recordUserId: string; actorUserId: string },
  recordHasApp: () => Promise<boolean>,
): Promise<void> {
  if (target.recordUserId === target.actorUserId) return;
  if (await recordHasApp()) return;
  const [idColumn, secretColumn] = CLIENT_COLUMNS[provider];
  const guardian = (await prisma.user.findUnique({
    where: { id: target.actorUserId },
    select: { [idColumn]: true, [secretColumn]: true },
  })) as Record<string, string | null> | null;
  const clientId = guardian?.[idColumn] ?? null;
  const clientSecret = guardian?.[secretColumn] ?? null;
  if (!clientId || !clientSecret) return;
  const record = await prisma.user.findUnique({
    where: { id: target.recordUserId },
    select: { clientAppSharedBy: true },
  });
  await prisma.user.update({
    where: { id: target.recordUserId },
    data: {
      [idColumn]: clientId,
      [secretColumn]: clientSecret,
      clientAppSharedBy: {
        ...readClientAppSharedBy(record?.clientAppSharedBy),
        [provider]: target.actorUserId,
      },
    },
  });
  await auditLog("integration.client_app.shared", {
    userId: target.recordUserId,
    actorUserId: target.actorUserId,
    details: { provider },
  });
}

/** Which provider apps on a record were borrowed, and from which guardian. */
export type ClientAppSharedBy = Partial<Record<OAuthKitProvider, string>>;

/** Read the stored marker, dropping anything that is not a provider → id. */
export function readClientAppSharedBy(value: unknown): ClientAppSharedBy {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: ClientAppSharedBy = {};
  for (const provider of Object.keys(CLIENT_COLUMNS) as OAuthKitProvider[]) {
    const guardianId = (value as Record<string, unknown>)[provider];
    if (typeof guardianId === "string" && guardianId.length > 0) {
      out[provider] = guardianId;
    }
  }
  return out;
}

type ReleaseDb = Pick<
  Prisma.TransactionClient,
  "user" | "accountGrant" | "auditLog"
>;

/** Why a borrowed app left the record, as the audit row names it. */
export type ClientAppReleaseReason = "disconnected" | "guardian_left";

/**
 * Remove a provider app the record borrowed from a guardian, if it did.
 *
 * The app's client id and secret are the guardian's; they stay on the record
 * only while they serve a connection the guardian may still act on. Does
 * nothing when the record's app for `provider` is its own (no marker).
 */
export async function releaseSharedClientApp(
  provider: OAuthKitProvider,
  recordUserId: string,
  reason: ClientAppReleaseReason,
  db: ReleaseDb = prisma,
): Promise<boolean> {
  const row = await db.user.findUnique({
    where: { id: recordUserId },
    select: { clientAppSharedBy: true },
  });
  const sharedBy = readClientAppSharedBy(row?.clientAppSharedBy);
  const guardianUserId = sharedBy[provider];
  if (!guardianUserId) return false;
  delete sharedBy[provider];
  const [idColumn, secretColumn] = CLIENT_COLUMNS[provider];
  await db.user.update({
    where: { id: recordUserId },
    data: {
      [idColumn]: null,
      [secretColumn]: null,
      clientAppSharedBy:
        Object.keys(sharedBy).length > 0 ? sharedBy : Prisma.DbNull,
    },
  });
  await auditLog("integration.client_app.removed", {
    userId: recordUserId,
    details: { provider, reason, sharedBy: guardianUserId },
    client: db,
  });
  return true;
}

/**
 * Remove every app the record borrowed from a guardian who no longer holds a
 * live MANAGE grant on it. Run after any change that can end a guardian's
 * access (revoke, renounce, removal, handover, the guardian's account
 * deletion or data wipe). A connection still using the removed app keeps its
 * imported data and asks for a reconnect at its next refresh, which a
 * remaining guardian finishes with their own app.
 */
export async function releaseUnbackedClientApps(
  recordUserId: string,
  db: ReleaseDb = prisma,
): Promise<number> {
  const row = await db.user.findUnique({
    where: { id: recordUserId },
    select: { clientAppSharedBy: true },
  });
  const sharedBy = readClientAppSharedBy(row?.clientAppSharedBy);
  let released = 0;
  for (const [provider, guardianUserId] of Object.entries(sharedBy) as [
    OAuthKitProvider,
    string,
  ][]) {
    const grant = await findActiveGrant(
      { grantorId: recordUserId, granteeId: guardianUserId },
      db,
    );
    if (grant && grantAllows(grant, "manage")) continue;
    if (
      await releaseSharedClientApp(provider, recordUserId, "guardian_left", db)
    ) {
      released += 1;
    }
  }
  return released;
}
