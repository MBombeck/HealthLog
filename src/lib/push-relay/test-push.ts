/**
 * The admin's manual canary: one harmless sealed alert (`RELAY_TEST`) to each
 * of the admin's own relay-bound devices, sent at once, with the relay's
 * answer per device and the delivery state of the push.
 *
 * Only an answer that carried a valid signature by a pinned relay key is
 * reported as the relay's answer; anything else shows as a transport failure,
 * the same rule every relay call follows. The push carries a neutral text and
 * no data; it has no side effect in the app.
 */
import { prisma } from "@/lib/db";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { isLocale } from "@/lib/i18n/config";
import { fromBase64Url } from "@/lib/push-relay/encoding";
import { sealForDevice } from "@/lib/push-relay/envelope";
import { collapseIdFor } from "@/lib/push-relay/sender-keys";
import {
  loadPushContext,
  ROUTABLE_DEVICE_SELECT,
  routeOf,
} from "@/lib/push-relay/route-device";
import {
  RELAY_CLASS_LIFETIME_S,
  sendRelayItems,
} from "@/lib/push-relay/relay-send";

export interface RelayTestResult {
  deviceId: string;
  model: string | null;
  /** The relay's signed answer for this push, or 0 and a transport reason. */
  relayStatus: number;
  relayResult: string;
  relayReason: string | null;
  /** The delivery row after the call: `accepted`, `pending`, `failed`, `dropped`. */
  delivery: string;
}

export async function sendRelayTestPush(userId: string): Promise<{
  outcome: "accepted" | "failed" | "waiting" | "no_device";
  results: RelayTestResult[];
}> {
  const [devices, user, ctx] = await Promise.all([
    prisma.device.findMany({
      where: { userId, apnsToken: { not: null }, pushKeyPublic: { not: null } },
      select: { ...ROUTABLE_DEVICE_SELECT, model: true },
    }),
    prisma.user.findUnique({ where: { id: userId }, select: { locale: true } }),
    loadPushContext(),
  ]);
  const relayDevices = devices.filter((d) => routeOf(d, ctx) === "relay");
  if (relayDevices.length === 0 || !ctx.keys) {
    return { outcome: "no_device", results: [] };
  }
  const { t } = getServerTranslator(
    isLocale(user?.locale) ? user.locale : "en",
  );
  const items = [];
  for (const device of relayDevices) {
    const pushKey = fromBase64Url(device.pushKeyPublic ?? "", 32);
    if (!pushKey || !device.apnsToken) continue;
    const sealed = sealForDevice({
      message: {
        pushClass: "alert",
        type: "RELAY_TEST",
        // The class's one lifetime, like every other alert over the relay.
        lifetimeSeconds: RELAY_CLASS_LIFETIME_S.alert,
        text: {
          title: t("notifications.relayTest.title"),
          body: t("notifications.relayTest.body"),
        },
        ui: { level: "passive" },
      },
      device: { apnsToken: device.apnsToken, pushKeyPublic: pushKey },
      senderPrivateKey: ctx.keys.senderPrivateKey,
    });
    items.push({
      deviceId: device.id,
      ref: sealed.id,
      pushClass: "alert" as const,
      eventType: "RELAY_TEST",
      envelope: sealed.envelope,
      collapse: collapseIdFor(
        ctx.keys.collapseSecret,
        device.apnsToken,
        sealed.id,
      ),
      expiresAt: new Date(sealed.exp * 1000),
    });
  }
  const summary = await sendRelayItems(items, ctx.config);
  const rows = await prisma.pushRelayDelivery.findMany({
    where: { OR: items.map((i) => ({ deviceId: i.deviceId, ref: i.ref })) },
    select: { deviceId: true, ref: true, status: true },
  });
  const results = items.map((item) => {
    const answer = summary.answers.find((a) => a.ref === item.ref);
    const device = relayDevices.find((d) => d.id === item.deviceId);
    return {
      deviceId: item.deviceId,
      model: device?.model ?? null,
      relayStatus: answer?.status ?? 0,
      relayResult: answer?.code ?? "not_sent",
      relayReason: answer?.reason ?? null,
      delivery: rows.find((r) => r.ref === item.ref)?.status ?? "failed",
    };
  });
  // `accepted` only when every device took it: one refused or failed item
  // is no success, however many others went.
  const outcome =
    items.length > 0 && summary.accepted === items.length
      ? "accepted"
      : summary.failed > 0 || summary.waiting + summary.owed === 0
        ? "failed"
        : "waiting";
  return { outcome, results };
}
