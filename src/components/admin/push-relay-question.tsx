"use client";

import { useState } from "react";
import { Send } from "lucide-react";
import { DecisionCard } from "@/components/settings/decision-card";
import { toastWrittenOutcome } from "@/components/outcome/outcome-toast";
import { useAuth } from "@/hooks/use-auth";
import { SERVER_SETUP_DOCS } from "@/lib/admin/server-setup";
import { showErrorToast } from "@/lib/errors/error-toast";
import { useTranslations } from "@/lib/i18n/context";
import {
  INVITE_REASONS,
  PushRelayEnableDialog,
  relayRefusalLabel,
} from "./push-relay-enable-dialog";
import {
  useAnswerPushRelayQuestion,
  type PushRelaySwitchBody,
} from "./use-push-relay";

/**
 * The one question to an admin: "Use the HealthLog push relay?". Shown
 * where an admin lands (the dashboard after signing in, the admin start page,
 * the server setup's notifications step) while the operator's decision is `undecided`, and only for an admin of a server whose
 * relay can be used at all (`push.relay.canDecide` of `/api/auth/me`).
 *
 * It goes away only by an answer, and the answer holds for the whole server:
 * no keeps the relay off and nobody is asked again; yes opens the switch's own
 * confirmations (terms, privacy notice, household, invite code), and the
 * decision is `on` once the registration at the relay succeeded. A refused
 * registration leaves the question open, with the reason, so the admin can
 * answer yes again with a code. The card is the shared `DecisionCard`: yes
 * goes ahead (primary), no declines (secondary), and the details sit behind
 * the one "Learn more".
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
  // A refusal for want of an invite code opens the dialog with the code
  // field showing.
  const [refusalNeedsInvite, setRefusalNeedsInvite] = useState(false);
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
        setRefusalNeedsInvite(
          reason !== undefined && INVITE_REASONS.has(next.reason ?? ""),
        );
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
    <DecisionCard
      data-slot="push-relay-question"
      icon={Send}
      title={t("admin.pushRelay.question.title")}
      body={t("admin.pushRelay.question.body")}
      learnMore={{
        href: SERVER_SETUP_DOCS.pushRelay,
        label: t("admin.pushRelay.docs"),
      }}
      note={
        refusal ? (
          <p className="text-sm" data-slot="push-relay-question-refusal">
            {t(refusal)}
          </p>
        ) : null
      }
      pending={answer.isPending}
      decline={{
        label: t("admin.pushRelay.question.no"),
        slot: "push-relay-question-no",
        onClick: () => send({ enabled: false }),
      }}
      accept={{
        label: t("admin.pushRelay.question.yes"),
        slot: "push-relay-question-yes",
        onClick: () => {
          setDialogKey((key) => key + 1);
          setDialogOpen(true);
        },
      }}
    >
      <PushRelayEnableDialog
        key={dialogKey}
        mode="enable"
        termsUrl={relay.termsUrl ?? null}
        privacyUrl={relay.privacyUrl ?? null}
        inviteOpen={refusalNeedsInvite}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onConfirm={send}
      />
    </DecisionCard>
  );
}
