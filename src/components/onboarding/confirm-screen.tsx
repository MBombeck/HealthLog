"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { BaselineForm } from "@/components/onboarding/baseline-form";
import { StepHeading } from "@/components/onboarding/step-heading";
import {
  screenHref,
  useOnboardingAnswer,
  useOnboardingComplete,
} from "@/components/onboarding/use-onboarding-flow";
import { ManagedProfileCreateForm } from "@/components/settings/access/managed-profile-create-form";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { localizedApiError } from "@/lib/api/localized-error";
import { localeLabels } from "@/lib/i18n/config";
import { useTranslations } from "@/lib/i18n/context";
import { MODULE_REGISTRY } from "@/lib/modules/registry";
import { confirmedModules } from "@/lib/onboarding/confirm-summary";
import type { OnboardingStateDto } from "@/lib/onboarding/needs";
import {
  firstResultApplies,
  nextScreen,
  previousScreen,
  questionsToPassBeforeConfirm,
} from "@/lib/onboarding/wizard-steps";

/**
 * v1.39 (C2) — the confirm screen.
 *
 * Three things on one screen, all of them confirmations rather than
 * questions (design spec §The screens, 3):
 *
 *   1. What the answers switch on — read off the registry's derivation
 *      (`confirmedModules`), never computed here, so the list confirmed is
 *      the list `POST /api/onboarding/complete` writes.
 *   2. The preferences the account already holds: units, language, timezone.
 *      Shown once, changeable in Settings, never asked again.
 *   3. The profile. For a record of one's own, the baseline fields (height,
 *      date of birth, sex, display name) with their per-field refusals; for
 *      "someone I look after", the managed-profile form instead, because
 *      that record is created HERE, after the questions, per the
 *      maintainer's answer to spec question 2.
 *
 * Confirming posts the completion — which derives the module map once and
 * stamps the account past the first-run redirect — and then goes wherever
 * the step machine says: the first-result screen when there is a task to
 * offer, otherwise done. When there is no task, the first-result step is
 * passed explicitly so the ledger reads as settled rather than owed.
 */
export function ConfirmScreen({ state }: { state: OnboardingStateDto }) {
  const { t, locale } = useTranslations();
  const router = useRouter();
  const { user } = useAuth();
  const complete = useOnboardingComplete();
  const answer = useOnboardingAnswer();
  const [finishing, setFinishing] = useState(false);

  const needs = state.needs;
  const forSomeoneElse = needs.recordTarget === "someone-else";
  const { chosen, alwaysOn } = confirmedModules(needs);
  const back = previousScreen(state, "confirm");

  const glucoseUnit = needs.units.glucoseUnit ?? user?.glucoseUnit ?? null;
  const unitPreference =
    needs.units.unitPreference ?? user?.unitPreference ?? "metric";

  /**
   * Complete the flow. `managedRecordId` is the profile "someone I look
   * after" just created: the route then applies the derivation to THAT
   * record and stamps this one complete without deriving, so the guardian's
   * own modules are never re-ordered around the child's answers.
   */
  async function finish(managedRecordId?: string) {
    if (finishing) return;
    setFinishing(true);
    try {
      // A question this flow never showed — Q6 for somebody with no
      // unit-bearing area — is passed on the ledger before the completion,
      // because the route derives only once EVERY question is answered or
      // passed, and a step nobody was asked cannot be answered.
      for (const id of questionsToPassBeforeConfirm(state)) {
        await answer.mutateAsync({ step: id, status: "skipped" });
      }
      const { onboarding } = await complete.mutateAsync(
        managedRecordId ? { managedRecordId } : undefined,
      );
      let written = onboarding ?? state;
      if (!firstResultApplies(written)) {
        // Nothing to offer, so the step is passed rather than left owed:
        // a pending step would keep the setup reading as unfinished forever.
        written = await answer.mutateAsync({
          step: "first-result",
          status: "skipped",
        });
      }
      router.push(screenHref(nextScreen(written, "confirm") ?? "done"));
    } catch (err) {
      toast.error(localizedApiError(err, t, "onboarding.errorGeneric"));
      setFinishing(false);
    }
  }

  const moduleNames = (keys: readonly (keyof typeof MODULE_REGISTRY)[]) =>
    keys.map((key) => t(MODULE_REGISTRY[key].labelKey)).join(", ");

  return (
    <section aria-labelledby="onboarding-confirm-title" className="space-y-6">
      <StepHeading
        id="onboarding-confirm-title"
        title={t("onboarding.flow.confirm.title")}
        description={t("onboarding.flow.confirm.body")}
      />

      <div
        className="bg-card border-border space-y-3 rounded-xl border p-4 md:p-6"
        data-slot="onboarding-confirm-modules"
      >
        <h2 className="text-base font-semibold">
          {t("onboarding.flow.confirm.modulesTitle")}
        </h2>
        <p className="text-sm" data-slot="onboarding-confirm-modules-on">
          {chosen.length > 0
            ? t("onboarding.flow.confirm.switchedOn", {
                modules: moduleNames(chosen),
              })
            : t("onboarding.flow.confirm.nothingExtra")}
        </p>
        <p className="text-muted-foreground text-sm">
          {t("onboarding.flow.confirm.alwaysOn", {
            modules: moduleNames(alwaysOn),
          })}
        </p>
        <p className="text-sm">
          {t("onboarding.flow.confirm.everythingElse")}{" "}
          <Link
            href="/settings/modules"
            className="text-primary underline underline-offset-4"
          >
            {t("onboarding.flow.confirm.modulesLink")}
          </Link>
        </p>
      </div>

      <dl
        className="bg-card border-border grid grid-cols-1 gap-x-3 gap-y-2 rounded-xl border p-4 text-sm sm:grid-cols-[auto_1fr] md:p-6"
        data-slot="onboarding-confirm-preferences"
      >
        {/* Grouped dt/dd pairs only: a stray child breaks the list's semantics. */}
        {glucoseUnit ? (
          <>
            <dt className="text-muted-foreground">
              {t("onboarding.flow.confirm.glucoseUnit")}
            </dt>
            <dd>{glucoseUnit}</dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">
          {t("onboarding.flow.confirm.unitPreference")}
        </dt>
        <dd>{t(`onboarding.flow.units.options.${unitPreference}`)}</dd>
        <dt className="text-muted-foreground">
          {t("onboarding.flow.confirm.language")}
        </dt>
        <dd>{localeLabels[locale]}</dd>
        {user?.timezone ? (
          <>
            <dt className="text-muted-foreground">
              {t("onboarding.flow.confirm.timezone")}
            </dt>
            <dd>{user.timezone}</dd>
          </>
        ) : null}
      </dl>
      <p className="text-sm">
        <Link
          href="/settings/account"
          className="text-primary underline underline-offset-4"
        >
          {t("onboarding.flow.confirm.changeInSettings")}
        </Link>
      </p>

      {forSomeoneElse ? (
        <div className="space-y-4" data-slot="onboarding-confirm-managed">
          <div className="space-y-1">
            <h2 className="text-base font-semibold">
              {t("onboarding.flow.confirm.managedTitle")}
            </h2>
            <p className="text-muted-foreground text-sm">
              {t("onboarding.flow.confirm.managedBody")}
            </p>
          </div>
          <ManagedProfileCreateForm
            submitLabel={t("onboarding.flow.confirm.managedCreate")}
            onCreated={(profile) => void finish(profile.id)}
          />
          <p className="text-sm">{t("onboarding.flow.confirm.managedLater")}</p>
          <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
            {back ? (
              <Button asChild variant="ghost" className="min-h-11 min-w-11">
                <Link href={screenHref(back)} data-slot="onboarding-back">
                  {t("onboarding.shell.back")}
                </Link>
              </Button>
            ) : (
              <span aria-hidden="true" />
            )}
            <Button
              type="button"
              variant="outline"
              onClick={() => void finish()}
              disabled={finishing}
              className="min-h-11"
              data-slot="onboarding-finish-without-profile"
            >
              {t("onboarding.flow.confirm.finishWithoutProfile")}
            </Button>
          </div>
        </div>
      ) : (
        <BaselineForm
          backHref={back ? screenHref(back) : undefined}
          initial={{
            heightCm: user?.heightCm ?? null,
            dateOfBirth: user?.dateOfBirth ?? null,
            gender: user?.gender ?? null,
          }}
          onConfirmed={finish}
          confirming={finishing}
        />
      )}
    </section>
  );
}
