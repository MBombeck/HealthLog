/**
 * POST /api/devices
 *
 * Native-client device registration. The iOS app calls this on login,
 * on APNs token rotation, and whenever a fresh `apnsToken` arrives from
 * `application:didRegisterForRemoteNotificationsWithDeviceToken:`. Both the
 * legacy `token` and `apnsToken` resolve to one canonical device.
 *
 * Cross-user-hijack guard:
 *   * A device `token` belongs to exactly one user. Re-registering the
 *     same value under a different account returns 409. APNs tokens
 *     aren't secrets, so trusting wire input would let anyone who
 *     learns one redirect another user's pushes.
 *   * The same guard applies to `apnsToken` — supplying an `apnsToken`
 *     that's already registered to a different user returns 409 with
 *     reason `apns_token_owned_by_other_user`.
 *
 * APNs registration:
 *   * `apnsToken` and `apnsEnvironment` are paired — supplying one
 *     without the other returns 422. The iOS client picks the gateway
 *     (`sandbox` for Debug builds, `production` for Release / TestFlight)
 *     because the server has no way to tell from the token alone.
 */
import { NextRequest } from "next/server";
import { z } from "zod/v4";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiError, apiSuccess, sanitiseZodIssues } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { annotate } from "@/lib/logging/context";
import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import { encrypt } from "@/lib/crypto";
import { checkRateLimit } from "@/lib/rate-limit";

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
    // (64 chars on most devices; cap at 256 for forward compat).
    apnsToken: z
      .string()
      .min(8)
      .max(256)
      .regex(/^[A-Fa-f0-9]+$/, "apnsToken must be hex")
      .optional(),
    apnsEnvironment: z.enum(["sandbox", "production"]).optional(),
    // v1.7.0 — per-device medication-delivery override. NULL (or
    // omitted) inherits the user-level roaming default. "server" forces
    // server APNs for this device; "client" forces local. Stored +
    // echoed; cron suppression stays user-level.
    medicationDelivery: z.enum(["server", "client"]).nullable().optional(),
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

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  // Per-user rate cap on device registration. The handler returns a
  // distinct 409 (`apns_token_owned_by_other_user` /
  // `token_owned_by_other_user`) when an `apnsToken` is already
  // bound to a different account — useful for the legitimate
  // cross-user-hijack guard, but it also means an authenticated user
  // could enumerate token ownership across accounts unboundedly. 20
  // device-mutations per 15 minutes is well outside any realistic
  // client behaviour (the iOS app registers once on login + on token
  // rotation; not 20× / window) while capping enumeration cost.
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
    liveActivityPushToken,
  } = parsed.data;

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
        select: {
          id: true,
          userId: true,
          token: true,
          medicationDelivery: true,
          liveActivityPushToken: true,
        },
      }),
      apnsToken
        ? tx.device.findFirst({
            where: { apnsToken },
            select: {
              id: true,
              userId: true,
              token: true,
              medicationDelivery: true,
              liveActivityPushToken: true,
            },
          })
        : null,
    ]);

    if (apnsDevice && apnsDevice.userId !== user.id) {
      return {
        conflict: "apns_token_owned_by_other_user" as const,
        deviceId: apnsDevice.id,
      };
    }
    if (legacyDevice && legacyDevice.userId !== user.id) {
      return {
        conflict: "token_owned_by_other_user" as const,
        deviceId: legacyDevice.id,
      };
    }

    // RefreshToken.deviceId stores the client-supplied Device.token value,
    // not the database row id. Keep this user's token family aligned when
    // APNs identifies an existing device under a changed legacy token.
    if (apnsDevice && apnsDevice.token !== token) {
      await tx.refreshToken.updateMany({
        where: { userId: user.id, deviceId: apnsDevice.token },
        data: { deviceId: token },
      });
    }

    // An APNs match is the canonical physical-device identity. If the newly
    // presented legacy token already has a second same-user row, carry its
    // explicit per-device state (including null clears), remove it, and update
    // the APNs row with the newly presented metadata.
    let canonicalDevice = apnsDevice ?? legacyDevice;
    let duplicateDevice: typeof legacyDevice = null;
    if (apnsDevice && legacyDevice && apnsDevice.id !== legacyDevice.id) {
      duplicateDevice = legacyDevice;
      await tx.device.deleteMany({
        where: { id: legacyDevice.id, userId: user.id },
      });
      canonicalDevice = apnsDevice;
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
      ...(liveActivityPushToken !== undefined
        ? { liveActivityPushToken }
        : duplicateDevice
          ? { liveActivityPushToken: duplicateDevice.liveActivityPushToken }
          : {}),
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
    }

    return { id: device.id };
  });

  if ("conflict" in registration) {
    await auditLog("device.register.denied", {
      userId: user.id,
      details: {
        reason: registration.conflict,
        deviceId: registration.deviceId,
      },
    });
    return registration.conflict === "apns_token_owned_by_other_user"
      ? apiError("APNs token already registered to another account", 409)
      : apiError("Device token already registered to another account", 409);
  }

  const { id } = registration;

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

  return apiSuccess({ id }, 201);
});
