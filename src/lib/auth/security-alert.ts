/**
 * The SECURITY_ALERT notifications: a sign-in from a new device, a passkey
 * added or removed, an access token revoked, and a device family signed out
 * because its refresh token was presented twice.
 *
 * Each one is localised against the recipient's own locale and goes through
 * the dispatcher, which applies the per-channel SECURITY_ALERT preference
 * (on by default). The APNs channel seals it for every device with a push key
 * and carries it over the relay too (`push-relay/apns-channel.ts`), always at
 * `ui.level: time-sensitive`: a security change the person did not make is
 * exactly what has to break through a Focus.
 *
 * The text names no credential and no secret. A passkey is "a passkey", a
 * token is "an access token"; the account's security page has the details.
 *
 * Best effort: a failure here never fails the action that caused it.
 */
import { prisma } from "@/lib/db";
import { dispatchNotification } from "@/lib/notifications/dispatcher";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { defaultLocale, isLocale, type Locale } from "@/lib/i18n/config";
import { getEvent } from "@/lib/logging/context";

export type SecurityAlertKind =
  | "new_device"
  | "passkey_added"
  | "passkey_removed"
  | "token_revoked"
  | "refresh_reuse";

type Translate = ReturnType<typeof getServerTranslator>["t"];

/** The title and body of each kind, under `notifications.security`. */
const TEXT: Record<
  SecurityAlertKind,
  (
    t: Translate,
    vars: Record<string, string>,
  ) => { title: string; body: string }
> = {
  new_device: (t, vars) => ({
    title: t("notifications.security.newDeviceTitle"),
    body: t("notifications.security.newDeviceBody", vars),
  }),
  passkey_added: (t) => ({
    title: t("notifications.security.passkeyAddedTitle"),
    body: t("notifications.security.passkeyAddedBody"),
  }),
  passkey_removed: (t) => ({
    title: t("notifications.security.passkeyRemovedTitle"),
    body: t("notifications.security.passkeyRemovedBody"),
  }),
  token_revoked: (t) => ({
    title: t("notifications.security.tokenRevokedTitle"),
    body: t("notifications.security.tokenRevokedBody"),
  }),
  refresh_reuse: (t) => ({
    title: t("notifications.security.refreshReuseTitle"),
    body: t("notifications.security.refreshReuseBody"),
  }),
};

async function localeOf(userId: string): Promise<Locale> {
  try {
    const row = await prisma.user.findUnique({
      where: { id: userId },
      select: { locale: true },
    });
    return isLocale(row?.locale) ? row.locale : defaultLocale;
  } catch {
    return defaultLocale;
  }
}

/**
 * Send one security alert to the account. `vars` fills the placeholders of
 * the kind's body (`device` and `location` for `new_device`). Never throws.
 */
export async function sendSecurityAlert(
  userId: string,
  kind: SecurityAlertKind,
  vars: Record<string, string> = {},
): Promise<boolean> {
  try {
    const { t } = getServerTranslator(await localeOf(userId));
    const text = TEXT[kind](t, vars);
    const outcome = await dispatchNotification({
      eventType: "SECURITY_ALERT",
      userId,
      title: text.title,
      message: text.body,
      metadata: { securityKind: kind },
      urgent: true,
    });
    return outcome.dispatched;
  } catch (err) {
    getEvent()?.addWarning(
      `security alert ${kind} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

/** The location text of a new-device alert, localised. */
export async function unknownLocationText(userId: string): Promise<string> {
  const { t } = getServerTranslator(await localeOf(userId));
  return t("notifications.security.unknownLocation");
}
