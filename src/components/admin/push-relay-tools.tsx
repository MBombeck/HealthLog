"use client";

import type { ReactNode } from "react";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { toastWrittenOutcome } from "@/components/outcome/outcome-toast";
import { showErrorToast } from "@/lib/errors/error-toast";
import { useTranslations } from "@/lib/i18n/context";
import { useRotatePushRelayKey, useSendPushRelayTest } from "./use-push-relay";

/**
 * The relay card's action row: "Learn more" on the left, and on a relay that
 * is on, the test push (the admin's manual canary, with the relay's signed
 * answer and the delivery state per device) and the on-demand rotation of
 * the instance key.
 *
 * The row comes last in the card and the answer of a test push stands above
 * it. Neither tool is the card's primary action (that is the switch), so both
 * are secondary; the rotation asks first, because the relay allows one a day.
 */
export function PushRelayTools({
  offered,
  registered,
  learnMore,
}: {
  offered: boolean;
  registered: boolean;
  learnMore: ReactNode;
}) {
  const { t } = useTranslations();
  const testPush = useSendPushRelayTest();
  const rotateKey = useRotatePushRelayKey();
  return (
    <>
      {offered && testPush.data && (
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
      <SettingsCardActions leading={learnMore}>
        {offered && (
          <>
            <ConfirmButton
              size="sm"
              slot="push-relay-rotate"
              label={t("admin.pushRelay.rotate.button")}
              title={t("admin.pushRelay.rotate.confirmTitle")}
              body={t("admin.pushRelay.rotate.confirmBody")}
              confirmLabel={t("admin.pushRelay.rotate.button")}
              disabled={!registered}
              pending={rotateKey.isPending}
              onConfirm={() =>
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
            />
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
          </>
        )}
      </SettingsCardActions>
    </>
  );
}
