"use client";

import { useEffect, useState } from "react";
import { BellRing, Loader2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TestConnectionButton } from "@/components/settings/test-connection-button";
import { useTranslations } from "@/lib/i18n/context";

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

export function WebPushCard() {
  const { t } = useTranslations();
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [isSupported, setIsSupported] = useState(true);
  const [isDenied, setIsDenied] = useState(false);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [msgType, setMsgType] = useState<"success" | "error" | null>(null);

  useEffect(() => {
    // Async I/O (browser API + service worker registration). The lint rule
    // allows setState inside async callbacks — only synchronous setState in
    // the effect body is rejected.
    async function checkSubscription() {
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
        setIsSupported(false);
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

    try {
      const vapidRes = await fetch("/api/notifications/vapid");
      if (!vapidRes.ok) {
        setMsg(t("settings.webPushNotConfigured"));
        setMsgType("error");
        setActionLoading(false);
        return;
      }
      const vapidData = await vapidRes.json();
      const vapidPublicKey = vapidData.data.publicKey;

      const registration = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;

      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToArrayBuffer(vapidPublicKey),
      });

      const subJson = subscription.toJSON();

      const res = await fetch("/api/notifications/web-push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          endpoint: subJson.endpoint,
          keys: {
            p256dh: subJson.keys?.p256dh ?? "",
            auth: subJson.keys?.auth ?? "",
          },
        }),
      });

      if (res.ok) {
        setIsSubscribed(true);
        setMsg(t("settings.webPushSubscribed"));
        setMsgType("success");
      } else {
        setMsg(t("settings.webPushSubscribeFailed"));
        setMsgType("error");
      }
    } catch {
      if (Notification.permission === "denied") {
        setIsDenied(true);
        setMsg(t("settings.webPushDenied"));
      } else {
        setMsg(t("settings.webPushSubscribeFailed"));
      }
      setMsgType("error");
    } finally {
      setActionLoading(false);
    }
  }

  async function handleUnsubscribe() {
    setActionLoading(true);
    setMsg(null);
    setMsgType(null);

    try {
      const registration =
        await navigator.serviceWorker.getRegistration("/sw.js");
      if (registration) {
        const subscription = await registration.pushManager.getSubscription();
        if (subscription) {
          await fetch("/api/notifications/web-push", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ endpoint: subscription.endpoint }),
          });

          await subscription.unsubscribe();
        }
      }

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

  return (
    <div className="bg-card border-border rounded-xl border p-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <BellRing className="text-primary h-5 w-5" />
          <h2 className="text-lg font-semibold">{t("settings.webPush")}</h2>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!loading && isSubscribed && (
            <Badge className="border-dracula-green/30 bg-dracula-green/15 text-dracula-green">
              {t("settings.configured")}
            </Badge>
          )}
          {!loading && isSubscribed && (
            <Badge variant="outline" className="text-xs">
              {t("settings.webPushActive")}
            </Badge>
          )}
        </div>
      </div>
      <p className="text-muted-foreground mt-1 text-xs">
        {t("settings.webPushDescription")}
      </p>

      <div className="mt-4 space-y-3">
        {loading ? (
          <div className="flex items-center gap-2">
            <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />
          </div>
        ) : !isSupported ? (
          <p className="text-muted-foreground text-sm">
            {t("settings.webPushNotSupported")}
          </p>
        ) : isDenied ? (
          <p className="text-destructive text-sm">
            {t("settings.webPushDenied")}
          </p>
        ) : (
          <div className="flex flex-wrap items-start gap-2">
            {isSubscribed ? (
              <Button
                variant="outline"
                size="sm"
                onClick={handleUnsubscribe}
                disabled={actionLoading}
              >
                {actionLoading && (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                )}
                {t("settings.webPushUnsubscribe")}
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={handleSubscribe}
                disabled={actionLoading}
              >
                {actionLoading ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <BellRing className="mr-1 h-3.5 w-3.5" />
                )}
                {t("settings.webPushSubscribe")}
              </Button>
            )}
            {isSubscribed && (
              <TestConnectionButton endpoint="/api/notifications/web-push/test" />
            )}
          </div>
        )}

        {msg && (
          <p
            role="alert"
            className={`text-sm ${msgType === "success" ? "text-dracula-green" : "text-destructive"}`}
          >
            {msg}
          </p>
        )}
      </div>
    </div>
  );
}
