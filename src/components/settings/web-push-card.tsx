"use client";

import { useEffect, useState } from "react";
import { BellRing, ExternalLink, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { InlineAction } from "@/components/ui/inline-action";
import { DOCS_GUIDES_BASE } from "@/components/settings/integrations/setup-guide-link";
import { TestConnectionButton } from "@/components/settings/test-connection-button";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { useTranslations } from "@/lib/i18n/context";
import { apiFetchRaw } from "@/lib/api/api-fetch";
import {
  saveWebPushSubscription,
  unsubscribeWebPush,
} from "@/lib/notifications/web-push-subscription";
import {
  classifyWebPushSubscribeFailure,
  isBraveBrowser,
  type WebPushSubscribeFailure,
} from "@/lib/notifications/web-push-subscribe-failure";

/** The docs section on Browser Push, linked when the browser refused. */
export const WEB_PUSH_DOCS_HREF = `${DOCS_GUIDES_BASE}/reminder-channels/#web-push-vapid`;

/** Convert a URL-safe base64 string to an ArrayBuffer (for VAPID key). */
function urlBase64ToArrayBuffer(base64String: string): ArrayBuffer {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const buffer = new ArrayBuffer(raw.length);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; ++i) {
    view[i] = raw.charCodeAt(i);
  }
  return buffer;
}

/**
 * iPhone and iPad offer Web Push only to HealthLog opened from the Home
 * Screen; in a Safari tab the API is missing. iPadOS Safari reports itself
 * as a Mac, so a Mac with a touch screen counts too.
 */
export function needsHomeScreen(): boolean {
  const ua = navigator.userAgent;
  const appleTouch =
    /iPhone|iPad|iPod/.test(ua) ||
    (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  return appleTouch && !window.matchMedia("(display-mode: standalone)").matches;
}

type Unsupported = "browser" | "install" | null;

/** What one press of "Enable push" ended in. */
type SubscribeOutcome =
  "subscribed" | "not-configured" | "save-failed" | WebPushSubscribeFailure;

/**
 * Subscribe this browser and store the subscription on the server. The
 * browser's own refusal is classified apart from the server's answers around
 * it: Brave, for one, rejects with "push service error" until push messaging
 * is switched on in its privacy settings, and "Activation failed" told nobody
 * that.
 */
async function subscribeThisBrowser(): Promise<SubscribeOutcome> {
  const vapidRes = await apiFetchRaw("/api/notifications/vapid");
  if (!vapidRes.ok) return "not-configured";
  const vapidData = await vapidRes.json();
  const vapidPublicKey = vapidData.data.publicKey;

  // Defer to the app-wide registration (`<ServiceWorkerRegistrar>` in the
  // root providers) rather than re-registering here — same scope, so a second
  // `register("/sw.js")` would only return the existing worker. `ready`
  // resolves with the active registration once it is controlling the page.
  const registration = await navigator.serviceWorker.ready;

  let subscription: PushSubscription;
  try {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToArrayBuffer(vapidPublicKey),
    });
  } catch (error) {
    return classifyWebPushSubscribeFailure(error, {
      permission: Notification.permission,
      isBrave: isBraveBrowser(),
    });
  }

  const res = await saveWebPushSubscription(subscription);
  return res.ok ? "subscribed" : "save-failed";
}

function subscribeOutcomeMessage(
  outcome: SubscribeOutcome,
  t: ReturnType<typeof useTranslations>["t"],
): string {
  switch (outcome) {
    case "subscribed":
      return t("settings.webPushSubscribed");
    case "not-configured":
      return t("settings.webPushNotConfigured");
    case "denied":
      return t("settings.webPushDenied");
    case "push-service":
      return t("settings.webPushServiceRefused");
    case "push-service-brave":
      return t("settings.webPushServiceRefusedBrave");
    case "save-failed":
    case "unknown":
      return t("settings.webPushSubscribeFailed");
  }
}

export function WebPushCard() {
  const { t } = useTranslations();
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [unsupported, setUnsupported] = useState<Unsupported>(null);
  const [isDenied, setIsDenied] = useState(false);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [msgType, setMsgType] = useState<"success" | "error" | null>(null);
  const [showHelp, setShowHelp] = useState(false);

  useEffect(() => {
    // Async I/O (browser API + service worker registration). The lint rule
    // allows setState inside async callbacks — only synchronous setState in
    // the effect body is rejected.
    async function checkSubscription() {
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
        setUnsupported(needsHomeScreen() ? "install" : "browser");
        setLoading(false);
        return;
      }

      if (Notification.permission === "denied") {
        setIsDenied(true);
        setLoading(false);
        return;
      }

      try {
        const registration =
          await navigator.serviceWorker.getRegistration("/sw.js");
        if (registration) {
          const subscription = await registration.pushManager.getSubscription();
          setIsSubscribed(!!subscription);
          // Sent again on every open: the server may have lost the row or
          // switched the channel off, and the browser cannot tell.
          if (subscription) {
            void saveWebPushSubscription(subscription).catch(() => null);
          }
        }
      } catch {
        // Ignore errors during check
      }
      setLoading(false);
    }

    void checkSubscription();
  }, []);

  async function handleSubscribe() {
    setActionLoading(true);
    setMsg(null);
    setMsgType(null);
    setShowHelp(false);

    let outcome: SubscribeOutcome;
    try {
      outcome = await subscribeThisBrowser();
    } catch {
      outcome = Notification.permission === "denied" ? "denied" : "unknown";
    }
    if (outcome === "subscribed") setIsSubscribed(true);
    if (outcome === "denied") setIsDenied(true);
    setMsg(subscribeOutcomeMessage(outcome, t));
    setMsgType(outcome === "subscribed" ? "success" : "error");
    // The push service refused: the fix is in the browser, so link the docs.
    setShowHelp(outcome === "push-service" || outcome === "push-service-brave");
    setActionLoading(false);
  }

  async function handleUnsubscribe() {
    setActionLoading(true);
    setMsg(null);
    setMsgType(null);

    try {
      await unsubscribeWebPush();
      setIsSubscribed(false);
      setMsg(t("settings.webPushUnsubscribed"));
      setMsgType("success");
    } catch {
      setMsg(t("settings.webPushSubscribeFailed"));
      setMsgType("error");
    } finally {
      setActionLoading(false);
    }
  }

  // The subscribe / unsubscribe control is this card's primary action, so it
  // sits where every other card's does: the bottom action row. It used to ride
  // the header status slot as an `outline`, which made the one card in the
  // channel group that carries an enable button look like the one card that
  // carries a status badge.
  const cardAction = loading ? (
    <Loader2 className="text-muted-foreground h-4 w-4 animate-spin motion-reduce:animate-none" />
  ) : unsupported || isDenied ? null : (
    <SettingsCardActions>
      {isSubscribed && (
        <TestConnectionButton endpoint="/api/notifications/web-push/test" />
      )}
      {isSubscribed ? (
        <Button
          size="sm"
          className="min-h-11"
          onClick={handleUnsubscribe}
          disabled={actionLoading}
        >
          {actionLoading && (
            <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
          )}
          {t("settings.webPushUnsubscribe")}
        </Button>
      ) : (
        <Button
          size="sm"
          className="min-h-11"
          onClick={handleSubscribe}
          disabled={actionLoading}
        >
          {actionLoading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
          ) : (
            <BellRing className="h-3.5 w-3.5" />
          )}
          {t("settings.webPushSubscribe")}
        </Button>
      )}
    </SettingsCardActions>
  );

  return (
    <SettingsCard>
      <SettingsCardHeader
        icon={BellRing}
        title={t("settings.webPush")}
        description={t("settings.webPushDescription")}
      />

      {(!loading && unsupported) || (!loading && isDenied) || msg ? (
        <div className="space-y-4">
          {!loading && unsupported === "install" ? (
            // Steps to follow: content, not meta.
            <p className="text-sm">{t("settings.webPushInstallFirst")}</p>
          ) : !loading && unsupported ? (
            <p className="text-muted-foreground text-sm">
              {t("settings.webPushNotSupported")}
            </p>
          ) : !loading && isDenied ? (
            <p className="text-destructive text-sm">
              {t("settings.webPushDenied")}
            </p>
          ) : null}

          {msg && (
            <p
              role="alert"
              className={`text-sm ${msgType === "success" ? "text-success" : "text-destructive"}`}
            >
              {msg}
            </p>
          )}
          {msg && showHelp && (
            <InlineAction asChild tone="primary" size="sm">
              <a
                href={WEB_PUSH_DOCS_HREF}
                target="_blank"
                rel="noopener noreferrer"
              >
                {t("settings.webPushHelpLink")}
                <ExternalLink aria-hidden="true" />
              </a>
            </InlineAction>
          )}
        </div>
      ) : null}

      {cardAction}
    </SettingsCard>
  );
}
