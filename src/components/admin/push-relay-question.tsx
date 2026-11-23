"use client";

import { useState } from "react";
import { Send } from "lucide-react";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { Button } from "@/components/ui/button";
import { InlineAction } from "@/components/ui/inline-action";
import { toastWrittenOutcome } from "@/components/outcome/outcome-toast";
import { useAuth } from "@/hooks/use-auth";
import { SERVER_SETUP_DOCS } from "@/lib/admin/server-setup";
import { showErrorToast } from "@/lib/errors/error-toast";
import { useTranslations } from "@/lib/i18n/context";
import {
  PushRelayEnableDialog,
  relayRefusalLabel,
} from "./push-relay-enable-dialog";
import {
  useAnswerPushRelayQuestion,
  type PushRelaySwitchBody,
} from "./use-push-relay";

/**
 * The one question to an admin: "Send push notifications through the
 * HealthLog relay?". Shown where an admin lands (the dashboard after signing
 * in, the admin start page, the server setup's notifications step) while the
 * operator's decision is `undecided`, and only for an admin of a server whose
 * relay can be used at all (`push.relay.canDecide` of `/api/auth/me`).
 *
 * It goes away only by an answer, and the answer holds for the whole server:
 * no keeps the relay off and nobody is asked again; yes opens the switch's own
 * confirmations (terms, privacy notice, household, invite code), and the
 * decision is `on` once the registration at the relay succeeded. A refused
 * registration leaves the question open, with the reason, so the admin can
 * answer yes again with a code. The two answers weigh the same.
 */
export function PushRelayQuestion() {
  const { t } = useTranslations();
  const { user } = useAuth();
  const answer = useAnswerPushRelayQuestion();
  const [dialogOpen, setDialogOpen] = useState(false);
  // A fresh dialog, with nothing ticked or entered, each time it opens.
  const [dialogKey, setDialogKey] = useState(0);
  const [refusal, setRefusal] = useState<ReturnType<
    typeof relayRefusalLabel
  > | null>(null);
  // Answered here: hidden at once, before `/api/auth/me` is read again.
  const [answered, setAnswered] = useState(false);

  const relay = user?.push?.relay;
  if (
    answered ||
    user?.role !== "ADMIN" ||
    relay?.canDecide !== true ||
    relay.operatorDecision !== "undecided"
  ) {
    return null;
  }

  function send(body: PushRelaySwitchBody) {
    answer.mutate(body, {
      onSuccess: (next) => {
        if (next.operatorDecision !== "undecided") setAnswered(true);
        if (!body.enabled) {
          toastWrittenOutcome(
            "success",
            t("admin.pushRelay.question.declined"),
          );
          return;
        }
        const reason = relayRefusalLabel(next);
        setRefusal(reason ?? null);
        toastWrittenOutcome(
          next.operatorDecision === "on"
            ? "success"
            : next.offered
              ? "partial"
              : "failed",
          t(
            reason ??
              (next.operatorDecision === "on"
                ? "admin.pushRelay.enabled"
                : "admin.pushRelay.saveFailed"),
          ),
        );
      },
      onError: (failure) =>
        showErrorToast(t("admin.pushRelay.saveFailed"), { cause: failure }),
    });
  }

  return (
    <SettingsCard data-slot="push-relay-question">
      <SettingsCardHeader
        icon={Send}
        title={t("admin.pushRelay.question.title")}
      />
      <p className="text-sm">{t("admin.pushRelay.question.body")}</p>
      {refusal ? (
        <p className="text-sm" data-slot="push-relay-question-refusal">
          {t(refusal)}
        </p>
      ) : null}
      <SettingsCardActions align="start">
        <Button
          variant="outline"
          size="sm"
          disabled={answer.isPending}
          onClick={() => {
            setDialogKey((key) => key + 1);
            setDialogOpen(true);
          }}
          data-slot="push-relay-question-yes"
        >
          {t("admin.pushRelay.question.yes")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={answer.isPending}
          onClick={() => send({ enabled: false })}
          data-slot="push-relay-question-no"
        >
          {t("admin.pushRelay.question.no")}
        </Button>
        <InlineAction asChild tone="muted" size="sm">
          <a
            href={SERVER_SETUP_DOCS.pushRelay}
            target="_blank"
            rel="noreferrer"
          >
            {t("admin.pushRelay.docs")}
          </a>
        </InlineAction>
      </SettingsCardActions>
      <PushRelayEnableDialog
        key={dialogKey}
        mode="enable"
        termsUrl={relay.termsUrl ?? null}
        privacyUrl={relay.privacyUrl ?? null}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onConfirm={send}
      />
    </SettingsCard>
  );
}
