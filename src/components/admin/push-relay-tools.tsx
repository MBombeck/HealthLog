"use client";

import { Button } from "@/components/ui/button";
import { toastWrittenOutcome } from "@/components/outcome/outcome-toast";
import { showErrorToast } from "@/lib/errors/error-toast";
import { useTranslations } from "@/lib/i18n/context";
import { useRotatePushRelayKey, useSendPushRelayTest } from "./use-push-relay";

/**
 * The relay card's tools: the test push (the admin's manual canary, with the
 * relay's signed answer and the delivery state per device) and the on-demand
 * rotation of the instance key.
 */
export function PushRelayTools({ registered }: { registered: boolean }) {
  const { t } = useTranslations();
  const testPush = useSendPushRelayTest();
  const rotateKey = useRotatePushRelayKey();
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={testPush.isPending || !registered}
          onClick={() =>
            testPush.mutate(undefined, {
              onError: (failure) =>
                showErrorToast(t("admin.pushRelay.test.failed"), {
                  cause: failure,
                }),
            })
          }
        >
          {t("admin.pushRelay.test.button")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={rotateKey.isPending || !registered}
          onClick={() =>
            rotateKey.mutate(undefined, {
              onSuccess: (r) =>
                toastWrittenOutcome(
                  r.outcome === "rotated" ? "success" : "failed",
                  t(
                    r.outcome === "rotated"
                      ? "admin.pushRelay.rotate.done"
                      : "admin.pushRelay.rotate.failed",
                  ),
                ),
              onError: (failure) =>
                showErrorToast(t("admin.pushRelay.rotate.failed"), {
                  cause: failure,
                }),
            })
          }
        >
          {t("admin.pushRelay.rotate.button")}
        </Button>
      </div>
      {testPush.data && (
        <ul className="text-sm" data-slot="push-relay-test-result">
          {testPush.data.outcome === "no_device" && (
            <li>{t("admin.pushRelay.test.noDevice")}</li>
          )}
          {testPush.data.results.map((r) => (
            <li key={r.deviceId}>
              {t("admin.pushRelay.test.line", {
                device: r.model ?? r.deviceId,
                answer:
                  r.relayStatus === 0
                    ? t("admin.pushRelay.test.unsigned")
                    : `${r.relayStatus} ${r.relayResult}${r.relayReason ? ` (${r.relayReason})` : ""}`,
                delivery: r.delivery,
              })}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
