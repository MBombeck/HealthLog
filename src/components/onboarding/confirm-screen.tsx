"use client";

import { useRef, useState } from "react";
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
import {
  ONBOARDING_SKIPPABLE_STEP_IDS,
  type OnboardingStateDto,
} from "@/lib/onboarding/needs";

/** A step the confirm screen may pass on the ledger without an answer. */
type PassableStepId = (typeof ONBOARDING_SKIPPABLE_STEP_IDS)[number];
import { isOnboardingSettled } from "@/lib/onboarding/needs";
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
/**
 * v1.39 (Wave C, C2) — the completion sequence, apart from the component so
 * a failure partway through it can be pinned without a browser.
 *
 * Passes every question the flow never showed (the route derives only once
 * EVERY question is answered or passed, and a step nobody was asked cannot be
 * answered), completes, passes the first-result step when there is no task to
 * offer, and navigates. It reports a failure by THROWING — the caller owns the
 * buttons and the toast.
 */
export async function runConfirmFinish(args: {
  /** The ledger as the last write left it; updated in place as steps pass. */
  ledger: { current: OnboardingStateDto };
  managedRecordId?: string;
  passStep: (step: PassableStepId) => Promise<OnboardingStateDto>;
  complete: (
    managedRecordId?: string,
  ) => Promise<{ onboarding?: OnboardingStateDto | null }>;
  navigate: (href: string) => void;
}): Promise<void> {
  for (const id of questionsToPassBeforeConfirm(args.ledger.current)) {
    args.ledger.current = await args.passStep(id);
  }
  const { onboarding } = await args.complete(args.managedRecordId);
  let written = onboarding ?? args.ledger.current;
  if (!firstResultApplies(written)) {
    // Nothing to offer, so the step is passed rather than left owed: a
    // pending step would keep the setup reading as unfinished forever.
    written = await args.passStep("first-result");
  }
  args.ledger.current = written;
  args.navigate(screenHref(nextScreen(written, "confirm") ?? "done"));
}

export function ConfirmScreen({
  state,
  demoMode = false,
}: {
  state: OnboardingStateDto;
  /**
   * True on a `DEMO_MODE` instance. Resolved by the page (a server
   * component) from the server-only env var and threaded down, the way the
   * root layout threads it into the shell — no client-side detection and no
   * extra request. The baseline step's anamnesis card is read-only there.
   */
  demoMode?: boolean;
}) {
  const { t, locale } = useTranslations();
  const router = useRouter();
  const { user } = useAuth();
  const complete = useOnboardingComplete();
  const answer = useOnboardingAnswer();
  const [finishing, setFinishing] = useState(false);
  /**
   * v1.39 (Wave C, C2) — the ledger as the last write left it (M-j).
   * `finish()` sends one PATCH per question the flow never showed; a failure
   * midway used to leave a partly-passed ledger that the next attempt walked
   * from the top again, because the `state` prop it read was the one this
   * screen was rendered with. Every mutation answers the written state, so
   * the ref carries the progress across attempts and
   * `questionsToPassBeforeConfirm` — which lists pending steps only — then
   * skips what the failed attempt already passed.
   */
  const ledger = useRef(state);

  const needs = state.needs;
  /**
   * v1.39 (Wave C, C5) — is `hl_onboarding=pending` still set? (research M-l)
   *
   * Both of this screen's Settings links are page routes, and the cookie is
   * cleared by the completion — which is what THIS screen calls. So on a
   * first run the proxy 307s both straight back into the flow: two links
   * that cannot go anywhere, under a sentence saying where things live. The
   * words are true, the links are not, so only the links go.
   */
  const settingsReachable =
    isOnboardingSettled(state) || state.completedAt !== null;
  const forSomeoneElse = needs.recordTarget === "someone-else";
  // `user.modules` is the map the navigation reads, so the screen can only
  // name a module the person actually has today — and only when the answers
  // are about that record. In the "someone I look after" arm they are not:
  // `POST /api/onboarding/complete` applies the derivation to the managed
  // record (or, when none was created, to nothing at all) and stamps the
  // guardian's own record without deriving. Reading the actor's map there
  // would name modules that are staying exactly where they are — the same
  // guardian-derivation confusion v1.38.18 closed in the write, re-entering
  // through the copy. An empty map makes the list empty.
  const { chosen, alwaysOn, wouldSwitchOff } = confirmedModules(
    needs,
    forSomeoneElse ? {} : (user?.modules ?? {}),
  );
  const back = previousScreen(state, "confirm");

  const glucoseUnit = needs.units.glucoseUnit ?? user?.glucoseUnit ?? null;
  const unitPreference =
    needs.units.unitPreference ?? user?.unitPreference ?? "metric";

  /**
   * Complete the flow. `managedRecordId` is the profile "someone I look
   * after" just created: the route then applies the derivation to THAT
   * record and stamps this one complete without deriving, so the guardian's
   * own modules are never re-ordered around the child's answers.
   *
   * v1.39 (Wave C, C2) — this RETHROWS. `<BaselineForm>` owns the two
   * buttons and releases them in its own `finally`, and it can only do that
   * for a failure it is told about: the previous version caught, toasted and
   * returned normally, which left both buttons disabled until a reload
   * (research I10). The two managed-arm callers, which have no form around
   * them, go through `finishReporting` below.
   */
  async function finish(managedRecordId?: string) {
    if (finishing) return;
    setFinishing(true);
    try {
      await runConfirmFinish({
        ledger,
        managedRecordId,
        passStep: (step) => answer.mutateAsync({ step, status: "skipped" }),
        complete: (id) =>
          complete.mutateAsync(id ? { managedRecordId: id } : undefined),
        navigate: (href) => router.push(href),
      });
    } catch (err) {
      setFinishing(false);
      throw err;
    }
  }

  /** The managed arm's two buttons: nothing above them reports a failure. */
  function finishReporting(managedRecordId?: string) {
    void finish(managedRecordId).catch((err) => {
      toast.error(localizedApiError(err, t, "onboarding.errorGeneric"));
    });
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
        {wouldSwitchOff.length > 0 ? (
          <p className="text-sm" data-slot="onboarding-confirm-modules-off">
            {t("onboarding.flow.confirm.switchesOff", {
              modules: moduleNames(wouldSwitchOff),
            })}
          </p>
        ) : null}
        <p className="text-muted-foreground text-sm">
          {t("onboarding.flow.confirm.alwaysOn", {
            modules: moduleNames(alwaysOn),
          })}
        </p>
        <p className="text-sm">
          {t("onboarding.flow.confirm.everythingElse")}{" "}
          {settingsReachable ? (
            <Link
              href="/settings/modules"
              className="text-primary underline underline-offset-4"
            >
              {t("onboarding.flow.confirm.modulesLink")}
            </Link>
          ) : (
            <span className="font-medium">
              {t("onboarding.flow.confirm.modulesLink")}
            </span>
          )}
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
        {settingsReachable ? (
          <Link
            href="/settings/account"
            className="text-primary underline underline-offset-4"
          >
            {t("onboarding.flow.confirm.changeInSettings")}
          </Link>
        ) : (
          <span className="text-muted-foreground">
            {t("onboarding.flow.confirm.changeInSettings")}
          </span>
        )}
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
            onCreated={(profile) => finishReporting(profile.id)}
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
              onClick={() => finishReporting()}
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
          demoMode={demoMode}
        />
      )}
    </section>
  );
}
