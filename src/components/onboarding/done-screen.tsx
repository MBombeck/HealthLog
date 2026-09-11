"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  CheckCircle2,
  Compass,
  FileUp,
  PlusCircle,
  Plug,
  Settings2,
  Sparkles,
  UserPlus,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { MedicalDisclaimer } from "@/components/common/medical-disclaimer";
import { SampleBriefingCard } from "@/components/onboarding/sample-briefing-card";
import { StepHeading } from "@/components/onboarding/step-heading";
import { useOnboardingAnswer } from "@/components/onboarding/use-onboarding-flow";
import { useAuth } from "@/hooks/use-auth";
import { useAccountSwitch } from "@/hooks/use-account-switch";
import { setTourReferrer } from "@/components/onboarding/tour-launcher";
import { queryKeys } from "@/lib/query-keys";
import { apiFetchRaw, apiGet } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import { markChecklistExpanded } from "@/lib/onboarding/checklist-storage";
import type { OnboardingStateDto } from "@/lib/onboarding/needs";
import { accountLabel } from "@/lib/sharing/account-access-view";

interface AiProviderStatus {
  /** Origin of the provider that would serve this user, if any. */
  managedBy?: "user" | "local" | "server" | null;
  /**
   * v1.38.19 (wave D) — the instance-wide tri-state. Fail closed: `unknown`
   * is treated exactly like `unhealthy`, here and everywhere.
   */
  serverProviderHealth?: "healthy" | "unhealthy" | "unknown";
  /** Whether the shared provider may honestly be offered in one tap. */
  serverProviderOffer?: boolean;
  /** Whether this user already holds an active `ai_full` / `ai_coach` receipt. */
  serverProviderConsent?: boolean;
}

/**
 * v1.39 (C2) — the setup flow's exit.
 *
 * The dashboard is one click away, already ordered, and the checklist opens
 * on arrival (design spec §The screens, 5). The tour is an OFFER here rather
 * than an automatic launch: pressing "Take a short tour" sets the referrer
 * the shell-level `<TourLauncher>` reads, and nothing else does, so somebody
 * who wants the dashboard gets the dashboard.
 *
 * Two record-shaped exits ride the answer to Q1: "both" is offered the
 * profile for the person they look after, and "someone I look after" — whose
 * profile was created on the confirm screen — is offered that record, through
 * the same switch the account menu uses, so their first entry lands in the
 * right record.
 *
 * The step is marked done on arrival, once. Everything else on this screen
 * is presentational: the module map was derived on confirm, the cookie
 * cleared there too.
 *
 * The AI panel leads with the payoff (a static, clearly-labelled SAMPLE
 * briefing — no model call, no egress, no consent), then the honest
 * local-first ladder and the "useful without AI" release valve. Value-first,
 * never a gate: every exit below stays, and setup is a single optional
 * deep-link.
 */

export function DoneScreen({ state }: { state: OnboardingStateDto }) {
  const { t } = useTranslations();
  const router = useRouter();
  const { user } = useAuth();
  const [sampleOpen, setSampleOpen] = useState(false);
  const answer = useOnboardingAnswer();
  const accountSwitch = useAccountSwitch();

  // Mark the step once. The write is idempotent, but a strict-mode double
  // mount would still send it twice; the ref keeps it to one.
  const marked = useRef(false);
  const donePending =
    state.steps.find((step) => step.id === "done")?.status === "pending";
  useEffect(() => {
    if (!donePending || marked.current) return;
    marked.current = true;
    answer.mutate({ step: "done" });
    // `answer` is a fresh object every render; the mutation it wraps is not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [donePending]);

  const recordTarget = state.needs.recordTarget;
  const managedRecord =
    recordTarget === "someone-else"
      ? (user?.accountAccess?.accounts.find(
          (entry) => entry.recordKind === "managed",
        ) ?? null)
      : null;

  function openDashboard() {
    markChecklistExpanded();
    router.push("/");
  }

  function takeTour() {
    if (user?.id) setTourReferrer(user.id);
    markChecklistExpanded();
    router.push("/");
  }

  // ── v1.38.19 (wave D) — the shared provider, offered only when it works ──
  //
  // This block used to be one line: `managedBy === "server"` painted a note
  // reading "insights work for you right now — no setup needed". Both halves
  // were wrong. `managedBy` is a PRESENCE read — it knows the operator
  // configured a key, never that the key answers — and "no setup needed"
  // skipped the consent receipt `consent-guard.ts` demands before any health
  // data reaches `admin-openai` / `admin-codex`, so the person who believed
  // the note walked into a `consent.ai.required` refusal on their first
  // briefing. On 2026-09-11 the operator's own instance was answering HTTP
  // 500 from its OAuth proxy while this note kept promising otherwise.
  //
  // The server decides now, and the four branches below only READ it. The
  // rest of the panel — sample, ladder, the "fully useful without AI" line,
  // the setup link — is identical in every branch; nothing here is a gate.
  const { data: aiProvider } = useQuery<AiProviderStatus>({
    queryKey: queryKeys.userAiProvider(),
    queryFn: async () => {
      return apiGet("/api/user/ai-provider");
    },
    enabled: !!user,
  });

  // The tap's own outcome, held locally so the line changes the moment the
  // receipt is minted rather than a refetch later.
  const [justGranted, setJustGranted] = useState(false);
  const queryClient = useQueryClient();
  const grantConsent = useMutation({
    mutationKey: queryKeys.aiConsentReceipt("ai_full"),
    mutationFn: async () => {
      // `intent: "affirmative"` marks this as the user's own consent act —
      // the only web path allowed to supersede an earlier withdrawal. The
      // silent mount heal posts no body and deliberately cannot.
      const res = await apiFetchRaw("/api/consent/ai/web", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intent: "affirmative" }),
      });
      if (!res.ok) throw new Error("consent grant failed");
    },
    onSuccess: async () => {
      setJustGranted(true);
      await queryClient.invalidateQueries({
        queryKey: queryKeys.userAiProvider(),
      });
      await queryClient.invalidateQueries({
        queryKey: queryKeys.aiConsentReceipt("ai_full"),
      });
    },
    onError: () => {
      // The button stays. A failed grant is a failed grant; the screen must
      // not read as though consent were on file.
      toast.error(t("onboarding.ai.offer.error"));
    },
  });

  const operatorProvides = aiProvider?.managedBy === "server";
  const consentOnFile =
    justGranted || aiProvider?.serverProviderConsent === true;
  const offerShared =
    operatorProvides &&
    !consentOnFile &&
    aiProvider?.serverProviderOffer === true;
  // Only a health verdict paints the "not answering" card. When the offer is
  // refused for a reason that is not health — the operator switched the
  // assistant surfaces off, or this is a managed profile whose provider is
  // the operator's by definition — the panel falls back to its neutral form
  // and claims nothing either way.
  const sharedUnavailable =
    operatorProvides &&
    !consentOnFile &&
    !offerShared &&
    (aiProvider?.serverProviderHealth === "unhealthy" ||
      aiProvider?.serverProviderHealth === "unknown");

  return (
    <section
      aria-labelledby="onboarding-done-title"
      className="flex flex-col items-center gap-6 py-6 text-center"
    >
      <span
        aria-hidden="true"
        className="bg-primary/10 text-primary flex size-20 items-center justify-center rounded-full"
      >
        <CheckCircle2 className="size-10" />
      </span>

      <div className="mx-auto max-w-md space-y-2">
        <StepHeading
          id="onboarding-done-title"
          title={t("onboarding.done.title")}
          description={t("onboarding.done.body")}
        />
        <p className="text-muted-foreground text-sm leading-relaxed">
          {t("onboarding.done.learning")}
        </p>
      </div>

      {/* v1.28 — the flagship AI value, made reachable at the one screen
          every fresh user passes through. The daily briefing / Coach need
          a provider the rest of onboarding never provisions, so this
          leads with the payoff (a static, clearly-labelled SAMPLE
          briefing — no model call, no egress, no consent), then the
          honest local-first ladder and the "useful without AI" release
          valve. Value-first, never a gate: the three exits below stay,
          and setup is a single optional deep-link. */}
      <section
        aria-labelledby="onboarding-ai-panel-title"
        data-slot="onboarding-ai-panel"
        className="border-border bg-card mx-auto flex w-full max-w-md flex-col gap-4 rounded-xl border p-4 text-left md:p-6"
      >
        <header className="flex items-start gap-3">
          <span
            aria-hidden="true"
            className="from-primary to-brand-pink flex size-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br"
          >
            <Sparkles className="text-background size-4" />
          </span>
          <div className="space-y-1">
            <h2
              id="onboarding-ai-panel-title"
              className="text-foreground text-base font-semibold tracking-tight"
            >
              {t("onboarding.ai.panelTitle")}
            </h2>
            <p className="text-muted-foreground text-sm leading-relaxed">
              {t("onboarding.ai.panelIntro")}
            </p>
          </div>
        </header>

        {sampleOpen ? (
          <SampleBriefingCard />
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full"
            data-slot="onboarding-ai-show-sample"
            onClick={() => setSampleOpen(true)}
          >
            {t("onboarding.ai.showSample")}
          </Button>
        )}

        {consentOnFile && operatorProvides ? (
          <p
            data-slot="onboarding-ai-shared-key"
            className="text-foreground bg-primary/5 border-primary/20 rounded-lg border px-3 py-2 text-sm leading-relaxed"
          >
            {justGranted
              ? t("onboarding.ai.offer.granted")
              : t("onboarding.ai.sharedKeyNote")}
          </p>
        ) : null}

        {offerShared ? (
          <div
            data-slot="onboarding-ai-offer"
            className="border-primary/20 bg-primary/5 space-y-2.5 rounded-lg border px-3 py-3"
          >
            <p className="text-foreground text-sm font-medium">
              {t("onboarding.ai.offer.title")}
            </p>
            <p className="text-muted-foreground text-sm leading-relaxed">
              {t("onboarding.ai.offer.body")}
            </p>
            <Button
              type="button"
              size="sm"
              className="min-h-9 w-full"
              data-slot="onboarding-ai-offer-grant"
              disabled={grantConsent.isPending}
              onClick={() => grantConsent.mutate()}
            >
              {t("onboarding.ai.offer.cta")}
            </Button>
          </div>
        ) : null}

        {sharedUnavailable ? (
          <div
            data-slot="onboarding-ai-unavailable"
            className="border-border bg-muted/40 space-y-1 rounded-lg border px-3 py-3"
          >
            <p className="text-foreground text-sm font-medium">
              {t("onboarding.ai.unavailable.title")}
            </p>
            <p className="text-muted-foreground text-sm leading-relaxed">
              {t("onboarding.ai.unavailable.body")}
            </p>
          </div>
        ) : null}

        <div className="space-y-2.5">
          <p className="text-foreground text-sm font-medium">
            {t("onboarding.ai.ladderTitle")}
          </p>
          <ul className="space-y-2.5">
            {/* Local first — the calm, private default — then BYOK, then
                the subscription/OAuth path with its training caveat. Same
                ordering + vendor-blind framing as the shipped document-
                provider governance. */}
            <li className="space-y-0.5">
              <p className="text-foreground text-sm font-medium">
                {t("onboarding.ai.ladderLocalTitle")}
              </p>
              <p className="text-muted-foreground text-sm leading-relaxed">
                {t("onboarding.ai.ladderLocalBody")}
              </p>
            </li>
            <li className="space-y-0.5">
              <p className="text-foreground text-sm font-medium">
                {t("onboarding.ai.ladderByokTitle")}
              </p>
              <p className="text-muted-foreground text-sm leading-relaxed">
                {t("onboarding.ai.ladderByokBody")}
              </p>
            </li>
            <li className="space-y-0.5">
              <p className="text-foreground text-sm font-medium">
                {t("onboarding.ai.ladderOauthTitle")}
              </p>
              <p className="text-muted-foreground text-sm leading-relaxed">
                {t("onboarding.ai.ladderOauthBody")}
              </p>
            </li>
          </ul>
        </div>

        <p
          data-slot="onboarding-ai-keyless"
          className="text-foreground text-sm leading-relaxed"
        >
          {t("onboarding.ai.keylessLine")}
        </p>

        <MedicalDisclaimer variant="dataPosture" />

        <Link
          href="/settings/ai"
          className="text-primary text-sm font-medium underline underline-offset-4"
        >
          {t("onboarding.ai.setupCta")}
        </Link>
      </section>

      <div className="flex w-full max-w-xs flex-col gap-2">
        <Button
          type="button"
          size="lg"
          onClick={openDashboard}
          className="min-h-11"
          data-slot="onboarding-open-dashboard"
        >
          {t("onboarding.done.returnCta")}
        </Button>
        <Button
          type="button"
          size="lg"
          variant="outline"
          onClick={takeTour}
          className="inline-flex min-h-11 items-center gap-2"
          data-slot="onboarding-take-tour"
        >
          <Compass className="size-4" />
          {t("onboarding.flow.done.tourCta")}
        </Button>
        {managedRecord ? (
          <Button
            type="button"
            size="lg"
            variant="outline"
            onClick={() => accountSwitch.mutate(managedRecord.accountId)}
            disabled={accountSwitch.isPending}
            className="inline-flex min-h-11 items-center gap-2"
            data-slot="onboarding-open-managed-record"
          >
            <UserPlus className="size-4" />
            {t("onboarding.flow.done.openRecord", {
              name: accountLabel(managedRecord),
            })}
          </Button>
        ) : null}
        {recordTarget === "both" ? (
          <Button asChild size="lg" variant="outline">
            <Link
              href="/settings/access"
              className="inline-flex min-h-11 items-center gap-2"
              data-slot="onboarding-create-managed-profile"
            >
              <UserPlus className="size-4" />
              {t("onboarding.flow.done.createProfile")}
            </Link>
          </Button>
        ) : null}
        <Button asChild variant="ghost">
          <Link
            href="/settings/integrations"
            className="inline-flex items-center gap-2"
          >
            <Plug className="size-4" />
            {t("onboarding.done.connectCta")}
          </Link>
        </Button>
        <Button asChild variant="ghost">
          <Link href="/measurements" className="inline-flex items-center gap-2">
            <PlusCircle className="size-4" />
            {t("onboarding.done.logCta")}
          </Link>
        </Button>
      </div>

      {/* 2026-07-17 UX-onboarding audit M5 — the module system (default-on
          set + opt-ins like nutrients / mental health / documents) is
          otherwise undiscoverable during first-run: the wizard never
          mentions it, and the only pointer used to be one tour stop.
          A quiet link here, beside the existing import link, gives every
          new account one honest pointer to Settings → Modules before they
          leave the wizard. */}
      <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5">
        <Link
          href="/settings/export"
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-sm underline underline-offset-4"
        >
          <FileUp className="size-3.5" />
          {t("onboarding.done.importCta")}
        </Link>
        <Link
          href="/settings/modules"
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-sm underline underline-offset-4"
        >
          <Settings2 className="size-3.5" />
          {t("onboarding.done.modulesCta")}
        </Link>
      </div>
    </section>
  );
}
