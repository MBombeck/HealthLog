"use client";

import { useState } from "react";

import {
  ConfirmationRow,
  INVITE_PATTERN,
  INVITE_REASONS,
  LINK,
  relayRefusalLabel,
} from "@/components/admin/push-relay-enable-dialog";
import { useAnswerPushRelayQuestion } from "@/components/admin/use-push-relay";
import { ChoiceChip } from "@/components/onboarding/choice-chip";
import { StepActions } from "@/components/onboarding/step-actions";
import { StepHeading } from "@/components/onboarding/step-heading";
import { Disclosure } from "@/components/ui/disclosure";
import { InlineAction } from "@/components/ui/inline-action";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";

import { useServerStep } from "./use-server-step";

type Answer = "yes" | "no";

/**
 * The push relay, answered inline (1.50). Nothing is chosen up front.
 *
 *  - Yes opens the same confirmations the switch asks for, inside the row:
 *    the relay terms, the privacy notice, the household, and the invite
 *    code one tap away. "Continue" waits for all three. A refused
 *    registration keeps the admin here with its reason, the question still
 *    open, as on the admin start page.
 *  - No keeps the relay off for the whole server; nobody is asked again.
 *  - Not now writes nothing: the question stays on the admin start page.
 *
 * A server whose relay cannot be used at all (an APNs key of its own, the
 * relay switched off in the environment) has no question to ask: the
 * previous step passes this one on the way, and a direct visit says so with
 * one Continue.
 */
export function RelayStep() {
  const { t } = useTranslations();
  const { user } = useAuth();
  const answer = useAnswerPushRelayQuestion();
  const step = useServerStep("relay");
  const relay = user?.push?.relay;
  const [choice, setChoice] = useState<Answer | null>(null);
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [readPrivacy, setReadPrivacy] = useState(false);
  const [household, setHousehold] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [invite, setInvite] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const inviteTrimmed = invite.trim();
  const inviteInvalid =
    inviteTrimmed !== "" && !INVITE_PATTERN.test(inviteTrimmed);
  const ready =
    choice === "no" ||
    (choice === "yes" &&
      acceptTerms &&
      readPrivacy &&
      household &&
      !inviteInvalid);

  const unavailable = user !== null && relay?.canDecide !== true;
  // Answered already (here, on the admin start page or by the switch): the
  // question is not asked again; the step only goes on.
  const decided =
    relay?.operatorDecision !== undefined &&
    relay.operatorDecision !== "undecided";

  async function next() {
    if (!ready || working) return;
    setWorking(true);
    setRefusal(null);
    try {
      const result = await answer.mutateAsync(
        choice === "yes"
          ? {
              enabled: true,
              acceptTerms: true,
              householdOnly: true,
              ...(inviteTrimmed ? { invite: inviteTrimmed } : {}),
            }
          : { enabled: false },
      );
      if (result.operatorDecision === "undecided") {
        const reason = relayRefusalLabel(result);
        setRefusal(t(reason ?? "admin.pushRelay.saveFailed"));
        if (INVITE_REASONS.has(result.reason ?? "")) setShowInvite(true);
        setWorking(false);
        return;
      }
      await step.record("done");
    } catch (err) {
      setWorking(false);
      step.fail(err);
    }
  }

  async function notNow() {
    if (working) return;
    setWorking(true);
    try {
      await step.record("skipped");
    } catch (err) {
      setWorking(false);
      step.fail(err);
    }
  }

  if (unavailable || decided) {
    return (
      <RelayDecided
        sentence={t(
          unavailable
            ? "setup.server.relay.unavailable"
            : relay?.operatorDecision === "on"
              ? "setup.server.relay.decidedOn"
              : "setup.server.relay.decidedOff",
        )}
        pending={working}
        onContinue={() => void notNow()}
      />
    );
  }

  return (
    <section
      aria-labelledby="server-setup-relay-title"
      className="flex flex-1 flex-col"
      data-slot="server-setup-step"
      data-step="relay"
    >
      <StepHeading
        id="server-setup-relay-title"
        title={t("admin.pushRelay.question.title")}
        description={t("setup.server.relay.body")}
        tone="foreground"
      />
      <Disclosure
        summary={t("setup.server.relay.more")}
        className="-mt-4 mb-4 [&>summary]:w-fit [&>summary]:justify-start"
        data-slot="server-setup-relay-more"
      >
        <p className="text-foreground">{t("setup.server.relay.detail")}</p>
      </Disclosure>
      <fieldset className="grid gap-2">
        <legend className="sr-only">
          {t("admin.pushRelay.question.title")}
        </legend>
        <ChoiceChip
          name="server-setup-relay"
          value="yes"
          kind="single"
          checked={choice === "yes"}
          onChange={() => setChoice("yes")}
          label={t("admin.pushRelay.question.yes")}
          hint={t("setup.server.relay.yesHint")}
        >
          <RelayConfirmations
            termsUrl={relay?.termsUrl ?? null}
            privacyUrl={relay?.privacyUrl ?? null}
            acceptTerms={acceptTerms}
            onAcceptTerms={setAcceptTerms}
            readPrivacy={readPrivacy}
            onReadPrivacy={setReadPrivacy}
            household={household}
            onHousehold={setHousehold}
            showInvite={showInvite}
            onShowInvite={() => setShowInvite(true)}
            invite={invite}
            onInvite={setInvite}
            inviteInvalid={inviteInvalid}
          />
        </ChoiceChip>
        <ChoiceChip
          name="server-setup-relay"
          value="no"
          kind="single"
          checked={choice === "no"}
          onChange={() => setChoice("no")}
          label={t("admin.pushRelay.question.no")}
          hint={t("setup.server.relay.noHint")}
        />
      </fieldset>
      {refusal ? (
        <p
          role="alert"
          className="text-destructive mt-4 text-sm"
          data-slot="server-setup-relay-refusal"
        >
          {refusal}
        </p>
      ) : null}
      <StepActions
        secondary={{
          label: t("setup.notNow"),
          onClick: () => void notNow(),
        }}
        primary={{
          label: t("onboarding.shell.next"),
          onClick: () => void next(),
          disabled: !ready,
        }}
        pending={working || answer.isPending}
      />
    </section>
  );
}

/** A relay that is not this step's question any more: one sentence, Continue. */
function RelayDecided({
  sentence,
  pending,
  onContinue,
}: {
  sentence: string;
  pending: boolean;
  onContinue: () => void;
}) {
  const { t } = useTranslations();
  return (
    <section
      aria-labelledby="server-setup-relay-title"
      className="flex flex-1 flex-col"
      data-slot="server-setup-step"
      data-step="relay"
    >
      <StepHeading
        id="server-setup-relay-title"
        title={t("admin.pushRelay.question.title")}
        description={sentence}
      />
      <StepActions
        primary={{ label: t("onboarding.shell.next"), onClick: onContinue }}
        pending={pending}
      />
    </section>
  );
}

/**
 * The relay's own confirmations, as the switch asks them: the terms, the
 * privacy notice, the household, and the invite code one tap away.
 */
function RelayConfirmations({
  termsUrl,
  privacyUrl,
  acceptTerms,
  onAcceptTerms,
  readPrivacy,
  onReadPrivacy,
  household,
  onHousehold,
  showInvite,
  onShowInvite,
  invite,
  onInvite,
  inviteInvalid,
}: {
  termsUrl: string | null;
  privacyUrl: string | null;
  acceptTerms: boolean;
  onAcceptTerms: (next: boolean) => void;
  readPrivacy: boolean;
  onReadPrivacy: (next: boolean) => void;
  household: boolean;
  onHousehold: (next: boolean) => void;
  showInvite: boolean;
  onShowInvite: () => void;
  invite: string;
  onInvite: (next: string) => void;
  inviteInvalid: boolean;
}) {
  const { t } = useTranslations();
  return (
    <>
      <ConfirmationRow
        id="push-relay-accept-terms"
        checked={acceptTerms}
        onCheckedChange={onAcceptTerms}
        sentence={t("admin.pushRelay.acceptTerms", { terms: LINK })}
        link={{
          href: termsUrl,
          label: t("admin.pushRelay.termsLink"),
        }}
      />
      <ConfirmationRow
        id="push-relay-read-privacy"
        checked={readPrivacy}
        onCheckedChange={onReadPrivacy}
        sentence={t("admin.pushRelay.readPrivacy", { privacy: LINK })}
        link={{
          href: privacyUrl,
          label: t("admin.pushRelay.privacyLink"),
        }}
      />
      <ConfirmationRow
        id="push-relay-household"
        checked={household}
        onCheckedChange={onHousehold}
        sentence={t("admin.pushRelay.householdOnly")}
        link={null}
      />
      {showInvite ? (
        <div className="space-y-1">
          <Label htmlFor="push-relay-invite">
            {t("admin.pushRelay.invite.label")}
          </Label>
          <Input
            id="push-relay-invite"
            value={invite}
            onChange={(event) => onInvite(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            maxLength={64}
            aria-invalid={inviteInvalid || undefined}
            aria-describedby="push-relay-invite-hint"
          />
          <p
            id="push-relay-invite-hint"
            className="text-muted-foreground text-xs"
          >
            {t(
              inviteInvalid
                ? "admin.pushRelay.invite.invalid"
                : "admin.pushRelay.invite.hint",
            )}
          </p>
        </div>
      ) : (
        <InlineAction
          tone="muted"
          size="sm"
          onClick={onShowInvite}
          data-slot="push-relay-invite-reveal"
        >
          {t("admin.pushRelay.invite.reveal")}
        </InlineAction>
      )}
    </>
  );
}
