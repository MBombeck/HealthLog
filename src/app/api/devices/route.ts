/**
 * POST /api/devices
 *
 * Native-client device registration. The iOS app calls this on login,
 * on APNs token rotation, and whenever a fresh `apnsToken` arrives from
 * `application:didRegisterForRemoteNotificationsWithDeviceToken:`. Both the
 * legacy `token` and `apnsToken` resolve to one canonical device.
 *
 * Account switch on one device:
 *   * A device `token` (the app's `X-Device-Id`) and an `apnsToken` name one
 *     physical install, and that install is signed in to one account at a
 *     time. A registration under account B for a token account A holds takes
 *     it over: A's row goes, with its push key, relay binding (unbound at the
 *     relay through the retrying queue before B's binding is forwarded) and
 *     Live Activity state, in the registration's transaction. Nothing sealed
 *     for A can reach the device under B. Both accounts get an audit row.
 *   * This used to answer 409, which left B without any server push on a
 *     phone A had signed out of, and A's reminders on B's lock screen.
 *     An APNs token is not a secret, so a takeover moves pushes only to the
 *     device that holds the token; it never shows A's data to B.
 *
 * APNs registration:
 *   * `apnsToken` and `apnsEnvironment` are paired — supplying one
 *     without the other returns 422. The iOS client picks the gateway
 *     (`sandbox` for Debug builds, `production` for Release / TestFlight)
 *     because the server has no way to tell from the token alone.
 */
import type { Prisma } from "@/generated/prisma/client";
import { isoDateTime } from "@/lib/validations/datetime";
import { NextRequest } from "next/server";
import { z } from "zod/v4";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiError, apiSuccess, sanitiseZodIssues } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { annotate } from "@/lib/logging/context";
import { prisma } from "@/lib/db";
import { deleteDeviceRowsIn } from "@/lib/devices/delete-devices";
import { auditLog } from "@/lib/auth/audit";
import { encrypt } from "@/lib/crypto";
import { checkRateLimit } from "@/lib/rate-limit";
import { endApnsNoDeviceRest } from "@/lib/notifications/channel-state";
import {
  LOCAL_RUNWAY_MAX_DAYS,
  localRunwayInBounds,
} from "@/lib/notifications/client-managed-apns";
import { drainQueuedUnbinds } from "@/lib/devices/signed-out-push";
import {
  activityStatementSchema,
  applyPushFields,
  devicePushFields,
  preparePushFields,
} from "@/lib/push-relay/device-registration";

const deviceSchema = z
  .object({
    token: z
      .string()
      .min(8)
      .max(512)
      .regex(/^[A-Za-z0-9+/=._:-]+$/, "Invalid token format"),
    bundleId: z.string().min(1).max(128),
    locale: z.string().min(2).max(16).optional(),
    appVersion: z.string().min(1).max(32).optional(),
    model: z.string().min(1).max(64).optional(),
    // APNs-specific pair — the iOS client populates these once it has
    // an APNs token from the OS callback. Hex string per Apple's spec
    // (64 chars on most devices; cap at 256 for forward compat). Stored in
    // lower case, so one token in other letters is the same token for the
    // ownership guard below (and for the relay, which compares lower case).
    apnsToken: z
      .string()
      .min(8)
      .max(256)
      .regex(/^[A-Fa-f0-9]+$/, "apnsToken must be hex")
      .transform((v) => v.toLowerCase())
      .optional(),
    apnsEnvironment: z.enum(["sandbox", "production"]).optional(),
    // v1.7.0 — per-device medication-delivery override. NULL (or
    // omitted) inherits the user-level roaming default. "server" forces
    // server APNs for this device; "client" forces local. Stored +
    // echoed; cron suppression stays user-level.
    medicationDelivery: z.enum(["server", "client"]).nullable().optional(),
    // How long the app has this device's medication reminders planned
    // locally: the dispatcher sends the server's reminder push again once it
    // passes (`client-managed-apns.ts`). Null clears it (back to the 3-day
    // quiet rule), omitted keeps it. Bounded: not in the past beyond a few
    // minutes of clock skew, at most 14 days ahead.
    localRunwayUntil: isoDateTime()
      .transform((v) => new Date(v))
      .refine((at) => localRunwayInBounds(at, new Date()), {
        message: `localRunwayUntil must lie between now and ${LOCAL_RUNWAY_MAX_DAYS} days ahead`,
      })
      .nullable()
      .optional(),
    // v1.17.1 (#22) — ActivityKit issues a per-Activity push token distinct
    // from the device APNs token. The iOS client registers the current one
    // here so the server can address a Live Activity update / end push on a
    // medication-intake mutation; it sends `null` to clear the token when no
    // Activity is running. Hex, like the APNs token. Only touched when the
    // field is present so an ordinary re-register keeps the prior value.
    liveActivityPushToken: z
      .string()
      .min(8)
      .max(256)
      .regex(/^[A-Fa-f0-9]+$/, "liveActivityPushToken must be hex")
      .nullable()
      .optional(),
    // The device's running medication Live Activities as a set, each with
    // its push token and the dose it shows. Present replaces the stored set
    // (an empty array clears it) and the legacy single token is ignored;
    // omitted keeps the set.
    liveActivityTokens: z
      .array(
        z
          .object({
            token: z
              .string()
              .min(8)
              .max(256)
              .regex(/^[A-Fa-f0-9]+$/),
            // A relay-started Activity knows no dose (its attributes are
            // fixed); the server fills in the dose it started.
            medicationId: z.string().min(1).max(64).optional(),
            relayStart: z.boolean().optional(),
            slotInstant: isoDateTime()
              .transform((v) => new Date(v))
              .optional(),
            // The device's signed `hl-activity-v1` statement for this
            // Activity. Kept here and handed to the push relay only inside the
            // end push, so the relay never learns when an Activity starts.
            statement: activityStatementSchema.optional(),
            signature: z
              .string()
              .regex(/^[A-Za-z0-9_-]{86}$/)
              .optional(),
          })
          .refine(
            (a) => a.medicationId !== undefined || a.relayStart === true,
            {
              message: "medicationId is required unless relayStart is true",
            },
          ),
      )
      .max(8)
      .optional(),
    // The push relay fields: the device's push key, the person's relay
    // consent and the signed relay binding (`push-relay/device-registration`).
    ...devicePushFields,
  })
  .refine(
    (v) =>
      (v.apnsToken === undefined && v.apnsEnvironment === undefined) ||
      (v.apnsToken !== undefined && v.apnsEnvironment !== undefined),
    {
      message:
        "apnsToken and apnsEnvironment must be supplied together or both omitted",
      path: ["apnsEnvironment"],
    },
  );

/**
 * The device-level Live Activity token to store: what the request sends,
 * else what the device row being merged held.
 */
function liveActivityFields(
  sent: { liveActivityPushToken?: string | null; liveActivityTokens?: unknown },
  previous: { liveActivityPushToken: string | null } | null,
) {
  // With the per-Activity list present the legacy single token is ignored.
  const token =
    sent.liveActivityTokens !== undefined
      ? undefined
      : sent.liveActivityPushToken;
  return token !== undefined
    ? { liveActivityPushToken: token }
    : previous
      ? { liveActivityPushToken: previous.liveActivityPushToken }
      : {};
}

/**
 * The device's running Activities, replaced as a set when the request names
 * them (an empty list clears them); omitted leaves them as they are.
 */
async function replaceLiveActivityTokens(
  tx: Prisma.TransactionClient,
  deviceId: string,
  sent: {
    liveActivityTokens?: Array<{
      token: string;
      medicationId?: string;
      relayStart?: boolean;
      slotInstant?: Date;
      statement?: Record<string, unknown>;
      signature?: string;
    }>;
  },
): Promise<void> {
  if (sent.liveActivityTokens === undefined) return;
  // A token the app once registered as relay-started stays so when a later
  // post of the set omits `relayStart`: the mark is the Activity's
  // attributes type, which never changes.
  const relayStarted = new Set(
    (
      await tx.liveActivityToken.findMany({
        where: { deviceId, relayStarted: true },
        select: { pushToken: true },
      })
    ).map((row) => row.pushToken.toLowerCase()),
  );
  await tx.liveActivityToken.deleteMany({ where: { deviceId } });
  if (sent.liveActivityTokens.length === 0) return;
  // The dose a relay start was for, for an Activity that knows none.
  const started = sent.liveActivityTokens.some((a) => !a.medicationId)
    ? await tx.device.findUnique({
        where: { id: deviceId },
        select: { laStartedMedicationId: true, laStartedSlot: true },
      })
    : null;
  const rows = sent.liveActivityTokens.flatMap((a) => {
    const medicationId = a.medicationId ?? started?.laStartedMedicationId;
    if (!medicationId) return [];
    return [
      {
        ...a,
        medicationId,
        slotInstant: a.medicationId
          ? a.slotInstant
          : (started?.laStartedSlot ?? undefined),
      },
    ];
  });
  if (rows.length === 0) return;
  await tx.liveActivityToken.createMany({
    data: rows.map((a) => ({
      deviceId,
      pushToken: a.token,
      medicationId: a.medicationId,
      slotInstant: a.slotInstant ?? null,
      relayStarted:
        a.relayStart === true || relayStarted.has(a.token.toLowerCase()),
      ...(a.statement && a.signature
        ? {
            activityStatement: a.statement as Prisma.InputJsonObject,
            activitySignature: a.signature,
          }
        : {}),
    })),
    skipDuplicates: true,
  });
}

const DEVICE_MERGE_SELECT = {
  id: true,
  userId: true,
  token: true,
  medicationDelivery: true,
  liveActivityPushToken: true,
  apnsToken: true,
  relayState: true,
  relayConsentAt: true,
} satisfies Prisma.DeviceSelect;

type MergeRow = Prisma.DeviceGetPayload<{ select: typeof DEVICE_MERGE_SELECT }>;

/**
 * Remove the rows of other accounts among the matches, queueing the relay
 * unbind of each token the relay may hold for them, inside the registration's
 * transaction. Returns the rows and the queued tokens.
 */
async function takeOver(
  tx: Prisma.TransactionClient,
  userId: string,
  rows: Array<MergeRow | null>,
) {
  const foreign = new Map<string, MergeRow>();
  for (const row of rows) {
    if (row && row.userId !== userId) foreign.set(row.id, row);
  }
  const takenOver = [...foreign.values()];
  const { unbinds } =
    takenOver.length > 0
      ? await deleteDeviceRowsIn(tx, {
          id: { in: takenOver.map((d) => d.id) },
        })
      : { unbinds: [] as string[] };
  return { takenOver, unbinds };
}

/**
 * After a takeover committed: the previous accounts' unbinds go out before
 * this request's binding is forwarded (the relay refuses a second binding key
 * for a token another binding still holds), and both sides get an audit row.
 */
async function afterTakeover(
  userId: string,
  deviceId: string,
  { takenOver, unbinds }: Awaited<ReturnType<typeof takeOver>>,
) {
  await drainQueuedUnbinds(unbinds);
  for (const previous of takenOver) {
    await auditLog("devices.register.taken_over", {
      userId: previous.userId,
      details: { deviceId: previous.id },
    });
  }
  if (takenOver.length === 0) return;
  await auditLog("devices.register.takeover", {
    userId,
    details: { deviceId, previousDeviceIds: takenOver.map((d) => d.id) },
  });
  annotate({ meta: { device_takeover: takenOver.length } });
}

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  // Per-user rate cap on device registration. A registration can take a
  // token over from another account, so an unbounded rate would let one
  // account churn another's device rows. 20 device-mutations per 15 minutes
  // is well outside any realistic client behaviour (the iOS app registers
  // once on login + on token rotation; not 20× / window).
  const rl = await checkRateLimit(
    `devices:register:${user.id}`,
    20,
    15 * 60 * 1000,
  );
  if (!rl.allowed) {
    annotate({
      action: { name: "devices.register.rate-limited" },
      meta: { userId: user.id, resetAt: rl.resetAt },
    });
    return apiError("Too many device registrations, please slow down", 429);
  }

  // v1.4.43 — iOS device-registration multi-issue 422 + audit
  // breadcrumb. APNs-token + bundleId + environment + model + locale
  // can all fail simultaneously on a misconfigured client build.
  const parsed = await parseJsonBody(request, deviceSchema, {
    maxBytes: 64 * 1024,
    action: "devices.register.validation-failed",
    countIssues: true,
    onInvalid: (error) => {
      // v1.4.49 — strip `message` from the audit-ledger row. Device
      // registration carries `token` + `apnsToken`; the default Zod
      // message for `invalid_format` echoes the offending value, which
      // would persist an APNs token (or a forged near-miss) into the
      // audit ledger.
      const auditIssues = sanitiseZodIssues(error.issues, {
        stripValuesFromMessage: true,
      });
      auditLog("devices.register.validation-failed", {
        userId: user.id,
        details: { issues: auditIssues },
      }).catch(() => {
        /* swallow — 422 response is the contract */
      });
    },
  });
  if (!parsed.ok) return parsed.error;

  const {
    token,
    bundleId,
    locale,
    appVersion,
    model,
    apnsToken,
    apnsEnvironment,
    medicationDelivery,
    localRunwayUntil,
  } = parsed.data;

  // Refused push fields (`preparePushFields`) answer before anything is
  // written; a relay-bound APNs token this replaces is noted for unbinding.
  const push = await preparePushFields(user.id, parsed.data);
  if (push.refused) return push.refused;

  const registration = await prisma.$transaction(async (tx) => {
    // Token ownership is decided from one database snapshot. Advisory
    // transaction locks serialize registrations that share either identity,
    // including cross-user attempts and the first-create race. Sorting avoids
    // deadlocks when concurrent requests present the same pair in reverse.
    const lockKeys = [
      `device-token:${token}`,
      ...(apnsToken ? [`device-apns:${apnsToken}`] : []),
    ].sort();
    for (const lockKey of lockKeys) {
      // `pg_advisory_xact_lock` returns void, which Prisma cannot deserialize
      // directly. Selecting through FROM yields a plain integer row.
      await tx.$queryRaw`
        SELECT 1 AS locked
        FROM pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))
      `;
    }

    const [legacyDevice, apnsDevice] = await Promise.all([
      tx.device.findUnique({
        where: { token },
        select: DEVICE_MERGE_SELECT,
      }),
      apnsToken
        ? tx.device.findFirst({
            where: { apnsToken },
            select: DEVICE_MERGE_SELECT,
          })
        : null,
    ]);

    // Another account's row for this install: taken over (see the header).
    const { takenOver, unbinds } = await takeOver(tx, user.id, [
      apnsDevice,
      legacyDevice,
    ]);
    const ownApns = apnsDevice?.userId === user.id ? apnsDevice : null;
    const ownLegacy = legacyDevice?.userId === user.id ? legacyDevice : null;

    // RefreshToken.deviceId stores the client-supplied Device.token value,
    // not the database row id. Keep this user's token family aligned when
    // APNs identifies an existing device under a changed legacy token.
    if (ownApns && ownApns.token !== token) {
      await tx.refreshToken.updateMany({
        where: { userId: user.id, deviceId: ownApns.token },
        data: { deviceId: token },
      });
    }

    // An APNs match is the canonical physical-device identity. If the newly
    // presented legacy token already has a second same-user row, carry its
    // explicit per-device state (including null clears), remove it, and update
    // the APNs row with the newly presented metadata.
    let canonicalDevice = ownApns ?? ownLegacy;
    let duplicateDevice: typeof ownLegacy = null;
    if (ownApns && ownLegacy && ownApns.id !== ownLegacy.id) {
      duplicateDevice = ownLegacy;
      // Its APNs token differs from the one presented (the partial unique
      // index gives that one to the APNs row), so an unbind queued for it
      // never touches the binding this request makes; the minute pass sends
      // it.
      await deleteDeviceRowsIn(tx, { id: ownLegacy.id, userId: user.id });
      canonicalDevice = ownApns;
    }

    const deviceData = {
      platform: "ios",
      token,
      bundleId,
      locale: locale ?? null,
      appVersion: appVersion ?? null,
      model: model ?? null,
      apnsToken: apnsToken ?? null,
      apnsEnvironment: apnsEnvironment ?? null,
      ...(medicationDelivery !== undefined
        ? { medicationDelivery }
        : duplicateDevice
          ? { medicationDelivery: duplicateDevice.medicationDelivery }
          : {}),
      ...liveActivityFields(parsed.data, duplicateDevice),
      ...(localRunwayUntil !== undefined ? { localRunwayUntil } : {}),
    };

    const device = canonicalDevice
      ? await tx.device.update({
          where: { id: canonicalDevice.id, userId: user.id },
          data: { ...deviceData, lastSeen: new Date() },
          select: { id: true },
        })
      : await tx.device.create({
          data: { userId: user.id, ...deviceData },
          select: { id: true },
        });

    await replaceLiveActivityTokens(tx, device.id, parsed.data);

    // Keep channel reconciliation under the same identity locks as the device
    // row. Moving it after commit lets two first-time registrations race the
    // compound unique key and intermittently turns one valid request into 500.
    if (apnsToken) {
      await tx.notificationChannel.upsert({
        where: { userId_type: { userId: user.id, type: "APNS" } },
        create: {
          userId: user.id,
          type: "APNS",
          enabled: true,
          config: encrypt("{}"),
        },
        update: {},
      });
      await endApnsNoDeviceRest(tx, user.id);
    }

    return { id: device.id, takenOver, unbinds };
  });

  const { id } = registration;
  await afterTakeover(user.id, id, registration);

  await auditLog("devices.register", {
    userId: user.id,
    details: {
      deviceId: id,
      bundleId,
      model: model ?? null,
      hasApnsToken: Boolean(apnsToken),
      apnsEnvironment: apnsEnvironment ?? null,
    },
  });

  annotate({
    action: { name: "devices.register", entity_type: "device", entity_id: id },
  });

  return apiSuccess({ id, push: await applyPushFields(id, parsed.data) }, 201);
});
