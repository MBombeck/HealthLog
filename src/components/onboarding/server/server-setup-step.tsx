"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { KeyRound, Mail, MapPin, MessageCircle } from "lucide-react";

import { AiServerKeySection } from "@/components/admin/ai-server-key-section";
import { AssistantSection } from "@/components/admin/assistant-section";
import { CentralCodexSection } from "@/components/admin/central-codex-section";
import { GeneralSettingsSection } from "@/components/admin/general-settings-section";
import { GlitchtipSection } from "@/components/admin/glitchtip-section";
import { PushRelayQuestion } from "@/components/admin/push-relay-question";
import { PushRelaySection } from "@/components/admin/push-relay-section";
import { RecoveryKitCard } from "@/components/admin/recovery-kit-card";
import { ServicesSection } from "@/components/admin/services-section";
import { SetupHealthCard } from "@/components/admin/setup-health-card";
import { GeoLookupStatusItem } from "@/components/admin/system-status-section";
import { UmamiSection } from "@/components/admin/umami-section";
import { StatusItem, useSystemStatus } from "@/components/admin/_shared";
import {
  useServerSetup,
  useServerSetupStep,
} from "@/lib/queries/use-server-setup";
import { StepActions } from "@/components/onboarding/step-actions";
import { StepHeading } from "@/components/onboarding/step-heading";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { SettingsCard } from "@/components/settings/settings-card";
import { InlineAction } from "@/components/ui/inline-action";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import {
  nextServerSetupStep,
  previousServerSetupStep,
  SERVER_SETUP_DOCS,
  type ServerSetupFacts,
  type ServerSetupStepId,
} from "@/lib/admin/server-setup";
import { localizedApiError } from "@/lib/api/localized-error";
import { showErrorToast } from "@/lib/errors/error-toast";
import { useTranslations } from "@/lib/i18n/context";

export function serverSetupHref(step: ServerSetupStepId): string {
  return `/onboarding/server/${step}`;
}

function DocsLink({ href, label }: { href: string; label: string }) {
  return (
    <InlineAction asChild size="sm" className="underline">
      <a href={href} target="_blank" rel="noreferrer">
        {label}
      </a>
    </InlineAction>
  );
}

/** What the environment says, beside the cards. Names and booleans only. */
function FactsCard({
  step,
  facts,
}: {
  step: "accounts" | "notifications";
  facts: ServerSetupFacts;
}) {
  const { t } = useTranslations();
  return (
    <SettingsCard data-slot={`server-setup-facts-${step}`}>
      <SettingsCardHeader
        icon={KeyRound}
        title={t("admin.serverSetup.facts.title")}
        description={t("admin.serverSetup.facts.description")}
      />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {step === "accounts" ? (
          <StatusItem
            icon={KeyRound}
            label={t("admin.serverSetup.facts.oidc")}
            value={
              facts.oidc.configured
                ? facts.oidc.only
                  ? t("admin.serverSetup.facts.oidcOnly")
                  : t("admin.serverSetup.facts.oidcOn")
                : t("admin.serverSetup.facts.oidcOff")
            }
            tone={facts.oidc.configured ? "success" : undefined}
          />
        ) : (
          <>
            <StatusItem
              icon={Mail}
              label={t("admin.serverSetup.facts.smtp")}
              value={
                facts.smtp.configured
                  ? t("admin.serverSetup.facts.smtpOn")
                  : t("admin.serverSetup.facts.smtpMissing", {
                      names: facts.smtp.missing.join(", "),
                    })
              }
              tone={facts.smtp.configured ? "success" : "warning"}
            />
            <StatusItem
              icon={MessageCircle}
              label={t("admin.serverSetup.facts.telegram")}
              value={
                facts.telegram.webhookSecret
                  ? t("admin.serverSetup.facts.telegramOn")
                  : t("admin.serverSetup.facts.telegramOff")
              }
              tone={facts.telegram.webhookSecret ? "success" : undefined}
            />
          </>
        )}
      </div>
      <p className="text-sm">
        {step === "accounts" ? (
          <DocsLink
            href={SERVER_SETUP_DOCS.signIn}
            label={t("admin.serverSetup.facts.oidcDocs")}
          />
        ) : (
          <DocsLink
            href={SERVER_SETUP_DOCS.reminderChannels}
            label={t("admin.serverSetup.facts.channelsDocs")}
          />
        )}
      </p>
    </SettingsCard>
  );
}

/** The geo lookup, read-only: decided by the environment, explained here. */
function GeoCard() {
  const { t } = useTranslations();
  const { data, isError, error, refetch } = useSystemStatus();
  return (
    <SettingsCard data-slot="server-setup-geo">
      <SettingsCardHeader
        icon={MapPin}
        title={t("admin.serverSetup.privacy.geoTitle")}
        description={t("admin.serverSetup.privacy.geoDescription")}
      />
      {data ? (
        <GeoLookupStatusItem geo={data.geo} />
      ) : isError ? (
        <QueryErrorRow
          inset
          error={error}
          message={t("admin.serverSetup.privacy.geoLoadError")}
          onRetry={() => void refetch()}
        />
      ) : null}
      <p className="text-sm">{t("admin.serverSetup.privacy.geoBody")}</p>
      <p className="text-sm">
        <DocsLink
          href={SERVER_SETUP_DOCS.geolite2}
          label={t("admin.serverSetup.privacy.geoDocs")}
        />
      </p>
    </SettingsCard>
  );
}

function StepBody({
  step,
  facts,
}: {
  step: ServerSetupStepId;
  facts: ServerSetupFacts | null;
}) {
  const { t } = useTranslations();
  switch (step) {
    case "accounts":
      return (
        <>
          {facts ? <FactsCard step="accounts" facts={facts} /> : null}
          <GeneralSettingsSection />
          <p className="text-sm">
            {t("admin.serverSetup.accounts.invites")}{" "}
            <InlineAction asChild size="sm" className="underline">
              <Link href="/admin/invites">
                {t("admin.serverSetup.accounts.invitesLink")}
              </Link>
            </InlineAction>
          </p>
        </>
      );
    case "notifications":
      return (
        <>
          {facts ? <FactsCard step="notifications" facts={facts} /> : null}
          <ServicesSection />
          <PushRelayQuestion />
          <PushRelaySection besideQuestion />
        </>
      );
    case "ai":
      return (
        <>
          <ul
            className="list-disc space-y-1.5 pl-5 text-sm"
            data-slot="server-setup-ai-egress"
          >
            <li>{t("admin.serverSetup.ai.off")}</li>
            <li>{t("admin.serverSetup.ai.ownKey")}</li>
            <li>{t("admin.serverSetup.ai.serverKey")}</li>
            <li>{t("admin.serverSetup.ai.local")}</li>
          </ul>
          <p className="text-sm">
            <DocsLink
              href={SERVER_SETUP_DOCS.aiProviders}
              label={t("admin.serverSetup.ai.docs")}
            />
          </p>
          <AssistantSection />
          <AiServerKeySection />
          <CentralCodexSection />
        </>
      );
    case "privacy":
      return (
        <>
          <GeoCard />
          <UmamiSection />
          <GlitchtipSection />
          <p className="text-sm">
            <DocsLink
              href={SERVER_SETUP_DOCS.privacy}
              label={t("admin.serverSetup.privacy.docs")}
            />
          </p>
        </>
      );
    case "health":
      return (
        <>
          <SetupHealthCard showSetupLink={false} />
          <p className="text-sm">{t("admin.serverSetup.health.keys")}</p>
          <RecoveryKitCard />
        </>
      );
  }
}

/**
 * 1.49 — one step of the first-admin server setup.
 *
 * Each step is the existing admin surface for its decision, in an order, with
 * the flow's own heading and actions around it: the cards save through their
 * own routes exactly as they do under Admin, and "Continue" / "Skip" only
 * record the step (`PATCH /api/admin/server-setup`). Nothing is forced: every
 * step is skippable, and every card stays where it always was under Admin.
 *
 * Passing the notifications step decides nothing about the push relay: only
 * an answer to the relay question (or the switch) does, so a skipped step
 * leaves the question open.
 */
export function ServerSetupStep({ step }: { step: ServerSetupStepId }) {
  const { t } = useTranslations();
  const router = useRouter();
  const setup = useServerSetup();
  const write = useServerSetupStep();
  const back = previousServerSetupStep(step);
  const next = nextServerSetupStep(step);

  async function persist(status: "done" | "skipped") {
    try {
      await write.mutateAsync({ step, status });
      router.push(next ? serverSetupHref(next) : "/");
    } catch (err) {
      showErrorToast(localizedApiError(err, t, "onboarding.errorGeneric"), {
        cause: err,
      });
    }
  }

  return (
    <section
      aria-labelledby="server-setup-title"
      className="space-y-6"
      data-slot="server-setup-step"
      data-step={step}
    >
      <StepHeading
        id="server-setup-title"
        title={t(`admin.serverSetup.${step}.title`)}
        description={t(`admin.serverSetup.${step}.body`)}
      />

      <div className="space-y-4">
        <StepBody step={step} facts={setup.data?.facts ?? null} />
      </div>

      <StepActions
        backHref={back ? serverSetupHref(back) : undefined}
        onSkip={() => void persist("skipped")}
        onNext={() => void persist("done")}
        nextLabel={next ? undefined : t("admin.serverSetup.finish")}
        pending={write.isPending}
      />
    </section>
  );
}
