import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { SetupFrame } from "@/components/onboarding/setup-frame";
import { ServerSetupStep } from "@/components/onboarding/server/server-setup-step";
import { getSession } from "@/lib/auth/session";
import {
  isServerSetupStepId,
  SERVER_SETUP_STEP_IDS,
  serverSetupCounter,
} from "@/lib/admin/server-setup";
import { serverSetupOfferedHere } from "@/lib/admin/server-setup-store";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { resolveServerLocale } from "@/lib/i18n/server-locale";

/**
 * 1.49 — one step of the first-admin server setup, under `/onboarding/` so
 * the first-run redirect lets it through before the admin's own setup and the
 * auth shell paints it without the app chrome. Admins only (the screens embed
 * admin cards whose routes are cookie-only `requireAdmin`), never on a demo
 * deploy. Steps are free to visit in any order: each is an offer, none waits
 * on another.
 */
export const dynamicParams = false;

export function generateStaticParams() {
  return SERVER_SETUP_STEP_IDS.map((step) => ({ step }));
}

interface PageProps {
  params: Promise<{ step: string }>;
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { step } = await params;
  if (!isServerSetupStepId(step)) return {};
  const session = await getSession();
  const locale = await resolveServerLocale({
    userLocale: session?.user.locale ?? null,
  });
  const { t } = getServerTranslator(locale);
  return { title: t(`admin.serverSetup.steps.${step}`) };
}

export default async function ServerSetupStepPage({ params }: PageProps) {
  const { step } = await params;
  if (!isServerSetupStepId(step)) notFound();
  const session = await getSession();
  if (!session) redirect("/auth/login");
  if (session.user.role !== "ADMIN" || !serverSetupOfferedHere()) notFound();

  const locale = await resolveServerLocale({
    userLocale: session.user.locale ?? null,
  });
  const { t } = getServerTranslator(locale);

  return (
    <SetupFrame
      screen={step}
      flow="server"
      counter={t("onboarding.shell.stepOf", serverSetupCounter(step))}
      stepsLabel={t("admin.serverSetup.stepsLabel")}
      steps={SERVER_SETUP_STEP_IDS.map((id) => ({
        id,
        label: t(`admin.serverSetup.steps.${id}`),
      }))}
    >
      <ServerSetupStep step={step} />
    </SetupFrame>
  );
}
