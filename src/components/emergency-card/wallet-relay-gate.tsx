"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import {
  PushRelayEnableDialog,
  relayRefusalLabel,
} from "@/components/admin/push-relay-enable-dialog";
import {
  useAnswerPushRelayQuestion,
  useSetPushRelay,
  type PushRelaySwitchBody,
} from "@/components/admin/use-push-relay";
import { toastWrittenOutcome } from "@/components/outcome/outcome-toast";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useAuth } from "@/hooks/use-auth";
import { apiPost } from "@/lib/api/api-fetch";
import type { EmergencyWalletApple } from "@/lib/emergency-card/wallet-pass/availability";
import { showErrorToast } from "@/lib/errors/error-toast";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

/**
 * "Add to Apple Wallet" on a server whose passes are signed over the push
 * relay while the relay is off (`state: relay_off`). What the caller can do
 * is the server's answer (`relayAction`), never worked out here:
 *
 * - `enable`, an admin: one sentence of what the relay is (the relay
 *   question's own words), then the switch's own confirmations, sent to the
 *   relay question's answer while it is open and to the switch otherwise, so
 *   the audit row is the one the admin pages write. Once the relay is
 *   registered the card goes on to the pass by itself.
 * - `ask_admin`, anybody else: who has to switch it on, and one button that
 *   closes.
 *
 * "Not now" and the closing button record the caller's no
 * (`relayHintDismissed`): the card stops prompting, the action stays.
 */
export function WalletRelayGate({
  apple,
  open,
  onOpenChange,
  onEnabled,
}: {
  apple: EmergencyWalletApple;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onEnabled: () => void;
}) {
  const { t } = useTranslations();
  const { user } = useAuth();
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const answer = useAnswerPushRelayQuestion();
  const set = useSetPushRelay();
  const dismiss = useMutation({
    mutationKey: queryKeys.emergencyCardWallet(),
    mutationFn: () =>
      apiPost<{ dismissed: true }>(
        "/api/emergency-card/wallet/apple/relay-hint",
      ),
    onSettled: () => qc.invalidateQueries({ queryKey: queryKeys.authMe() }),
  });

  function decline() {
    if (!apple.relayHintDismissed) dismiss.mutate();
  }

  const relay = user?.push?.relay;
  function enable(body: PushRelaySwitchBody) {
    setConfirming(false);
    // The open question takes the answer; a relay once declined or left
    // unfinished is changed by the switch. Both turn it on the same way.
    const send =
      relay?.operatorDecision === "undecided" ? answer.mutate : set.mutate;
    send(body, {
      onSuccess: (next) => {
        const refusal = relayRefusalLabel(next);
        if (next.instanceId) {
          toastWrittenOutcome("success", t("admin.pushRelay.enabled"));
          onEnabled();
        } else {
          toastWrittenOutcome(
            next.offered ? "partial" : "failed",
            t(refusal ?? "admin.pushRelay.saveFailed"),
          );
        }
      },
      onError: (failure) =>
        showErrorToast(t("admin.pushRelay.saveFailed"), { cause: failure }),
    });
  }

  const admin = apple.relayAction === "enable";
  return (
    <>
      <AlertDialog open={open} onOpenChange={onOpenChange}>
        <AlertDialogContent data-slot="wallet-relay-gate">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("emergencyCard.appleWallet.relay.title")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {admin
                ? t("admin.pushRelay.question.body")
                : t("emergencyCard.appleWallet.relay.askAdmin")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            {admin ? (
              <>
                <AlertDialogCancel
                  data-slot="wallet-relay-not-now"
                  onClick={decline}
                >
                  {t("emergencyCard.appleWallet.relay.notNow")}
                </AlertDialogCancel>
                <AlertDialogAction
                  data-slot="wallet-relay-enable"
                  onClick={() => setConfirming(true)}
                >
                  {t("admin.pushRelay.enable")}
                </AlertDialogAction>
              </>
            ) : (
              <AlertDialogAction
                data-slot="wallet-relay-close"
                onClick={decline}
              >
                {t("common.close")}
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {admin ? (
        <PushRelayEnableDialog
          mode="enable"
          termsUrl={relay?.termsUrl ?? null}
          privacyUrl={relay?.privacyUrl ?? null}
          open={confirming}
          onOpenChange={setConfirming}
          onConfirm={enable}
        />
      ) : null}
    </>
  );
}
