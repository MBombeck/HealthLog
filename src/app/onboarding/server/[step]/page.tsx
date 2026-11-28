import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { FinishLaterButton } from "@/components/onboarding/finish-later-button";
import { SetupFrame } from "@/components/onboarding/setup-frame";
import { ServerSetupStep } from "@/components/onboarding/server/server-setup-step";
import { getSession } from "@/lib/auth/session";
import {
  isServerSetupStepId,
  previousServerSetupStep,
  SERVER_SETUP_STEP_IDS,
  serverSetupStepper,
} from "@/lib/admin/server-setup";
import { serverSetupOfferedHere } from "@/lib/admin/server-setup-store";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { resolveServerLocale } from "@/lib/i18n/server-locale";

/**
 * One step of the first-admin server setup, under `/onboarding/` so the
 * first-run redirect lets it through and the auth shell paints it without
 * the app chrome. Admins only, never on a demo deploy. The owner account
 * itself is the first part of the "Account" segment, on `/auth/register`.
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
  return {
    title: t(`setup.server.segments.${serverSetupStepper(step).segment}`),
  };
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
  const stepper = serverSetupStepper(step);
  const previous = previousServerSetupStep(step);

  return (
    <SetupFrame
      screen={step}
      flow="server"
      stepper={{
        steps: stepper.segments.map((id) => ({
          id,
          label: t(`setup.server.segments.${id}`),
        })),
        current: stepper.current,
        fraction: stepper.fraction,
        countLabel: t("onboarding.shell.stepOf", {
          current: stepper.current + 1,
          total: stepper.segments.length,
        }),
      }}
      back={
        previous
          ? {
              href: `/onboarding/server/${previous}`,
              label: t("onboarding.shell.back"),
            }
          : undefined
      }
      later={<FinishLaterButton flow="server" />}
    >
      <ServerSetupStep step={step} />
    </SetupFrame>
  );
}
