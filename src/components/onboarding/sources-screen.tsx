"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  Bike,
  CircleDot,
  FileUp,
  HeartPulse,
  Scale,
  Smartphone,
  Watch,
  Check,
  type LucideIcon,
} from "lucide-react";

import { usePersonFlow } from "@/components/onboarding/person-flow";
import { StepActions } from "@/components/onboarding/step-actions";
import { StepHeading } from "@/components/onboarding/step-heading";
import {
  useIntegrationStatuses,
  type IntegrationKey,
  type IntegrationStatusViewModel,
} from "@/components/settings/integrations/shared";
import { Button, buttonVariants } from "@/components/ui/button";
import { InlineAction } from "@/components/ui/inline-action";
import { useAuth } from "@/hooks/use-auth";
import { useMounted } from "@/hooks/use-mounted";
import { apiGet } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import { loadDocument } from "@/lib/navigation/load-document";
import type {
  OnboardingSourceKey,
  OnboardingStateDto,
} from "@/lib/onboarding/needs";
import { markSetupReturn } from "@/lib/onboarding/setup-return";
import type { PersonSegmentId } from "@/lib/onboarding/wizard-steps";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";

/** The App Store listing of the iPhone app the QR code opens. */
export const IOS_APP_STORE_URL = "https://apps.apple.com/app/id6769501341";

/**
 * The OAuth sources the browser can connect from here, in the order they are
 * listed, with the answer each one records and the glyph of its card.
 */
const OAUTH_SOURCES: ReadonlyArray<{
  integration: IntegrationKey;
  answer: OnboardingSourceKey;
  Icon: LucideIcon;
}> = [
  { integration: "withings", answer: "withings", Icon: Scale },
  { integration: "oura", answer: "oura", Icon: CircleDot },
  { integration: "whoop", answer: "whoop", Icon: Activity },
  { integration: "polar", answer: "polar", Icon: Watch },
  { integration: "google-health", answer: "fitbit", Icon: HeartPulse },
  { integration: "strava", answer: "strava", Icon: Bike },
];

/** A source this server can connect: its app is configured here. */
function connectable(status: IntegrationStatusViewModel | undefined): boolean {
  if (!status) return false;
  return status.configured !== false && status.available !== false;
}

function connected(status: IntegrationStatusViewModel | undefined): boolean {
  return status?.connected === true;
}

/**
 * Whether the iPhone app can reach this server: it signs in over HTTPS only,
 * so a server on plain HTTP cannot be paired and the row is not offered.
 */
function phoneCanReach(origin: string): boolean {
  return origin.startsWith("https://");
}

/**
 * Where the readings come from: each row connects (1.50). Apple Health is
 * the iPhone app (a QR code to the App Store and the address to sign in
 * with); the OAuth services this server holds an app for start their
 * handshake here and come back to this screen; a file opens the import.
 * A service the server has no credentials for is not listed. An admin gets
 * one line to the admin page where more can be added.
 */
export function SourcesScreen({
  state,
  plan,
}: {
  state: OnboardingStateDto;
  plan: readonly PersonSegmentId[] | null;
}) {
  const { t } = useTranslations();
  const { user } = useAuth();
  const flow = usePersonFlow(state, plan, "sources");
  const mounted = useMounted();
  const origin = mounted ? window.location.origin : "";
  const statuses = useIntegrationStatuses(true);
  const healthkit = useQuery({
    queryKey: queryKeys.healthKitStatus(),
    queryFn: () =>
      apiGet<{ lastSyncedAt: string | null }>("/api/integrations/healthkit"),
  });
  const [working, setWorking] = useState(false);

  const status = (key: IntegrationKey) =>
    statuses.data?.integrations.find((entry) => entry.integration === key);
  const offered = OAUTH_SOURCES.filter((source) =>
    connectable(status(source.integration)),
  );
  const appleConnected = Boolean(healthkit.data?.lastSyncedAt);

  function connect(integration: IntegrationKey) {
    markSetupReturn("/onboarding/sources");
    loadDocument(`/api/${integration}/connect`);
  }

  async function next(skip: boolean) {
    if (working) return;
    setWorking(true);
    try {
      const sources: OnboardingSourceKey[] = [
        ...(appleConnected ? (["apple-health"] as const) : []),
        ...offered
          .filter((source) => connected(status(source.integration)))
          .map((source) => source.answer),
      ];
      const written = await flow.record(
        skip || sources.length === 0
          ? { step: "sources", status: "skipped" }
          : { step: "sources", sources },
      );
      await flow.advance(written);
    } catch (err) {
      setWorking(false);
      flow.fail(err);
    }
  }

  return (
    <section
      aria-labelledby="onboarding-sources-title"
      className="flex flex-1 flex-col"
    >
      <StepHeading
        id="onboarding-sources-title"
        title={t("setup.person.sources.title")}
        description={t("setup.person.sources.body")}
      />
      <ul
        className="border-border bg-card divide-border divide-y rounded-lg border"
        data-slot="onboarding-sources"
      >
        {phoneCanReach(origin) ? (
          <AppleHealthRow origin={origin} connected={appleConnected} />
        ) : null}
        {offered.map((source) => {
          const isConnected = connected(status(source.integration));
          return (
            <SourceRow
              key={source.integration}
              id={source.integration}
              Icon={source.Icon}
              label={t(`setup.person.sources.names.${source.integration}`)}
              hint={t(`setup.person.sources.hints.${source.integration}`)}
              action={
                isConnected ? (
                  <ConnectedMark />
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="min-h-11 sm:min-h-9"
                    onClick={() => connect(source.integration)}
                    data-slot="onboarding-source-connect"
                  >
                    {t("setup.person.sources.connect")}
                  </Button>
                )
              }
            />
          );
        })}
        <SourceRow
          id="file"
          Icon={FileUp}
          label={t("onboarding.flow.sources.options.file")}
          hint={t("setup.person.sources.hints.file")}
          action={
            <Link
              href="/settings/export"
              onClick={() => markSetupReturn("/onboarding/sources")}
              className={cn(
                buttonVariants({ variant: "outline", size: "sm" }),
                "min-h-11 sm:min-h-9",
              )}
              data-slot="onboarding-source-file"
            >
              {t("setup.person.sources.chooseFile")}
            </Link>
          }
        />
      </ul>
      {user?.role === "ADMIN" ? (
        <p className="mt-4 text-sm">
          <InlineAction asChild size="sm">
            <Link href="/admin/integrations?from=setup">
              {t("setup.person.sources.adminMore")}
            </Link>
          </InlineAction>
        </p>
      ) : null}
      <StepActions
        secondary={{
          label: t("onboarding.shell.skip"),
          onClick: () => void next(true),
        }}
        primary={{
          label: t("onboarding.shell.next"),
          onClick: () => void next(false),
        }}
        pending={working}
      />
    </section>
  );
}

function ConnectedMark() {
  const { t } = useTranslations();
  return (
    <span
      className="text-success inline-flex items-center gap-1 text-sm font-medium"
      data-slot="onboarding-source-connected"
    >
      <Check aria-hidden="true" className="size-4" />
      {t("setup.person.sources.connected")}
    </span>
  );
}

function SourceRow({
  id,
  Icon,
  label,
  hint,
  action,
  children,
}: {
  id: string;
  Icon: LucideIcon;
  label: string;
  hint: string;
  action: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <li className="px-4 py-3" data-slot="onboarding-source" data-source={id}>
      <div className="flex items-center gap-3">
        <Icon aria-hidden="true" className="text-foreground size-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{label}</p>
          <p className="text-muted-foreground text-xs">{hint}</p>
        </div>
        <div className="shrink-0">{action}</div>
      </div>
      {children}
    </li>
  );
}

/**
 * Apple Health: the iPhone app. The QR code opens the app's App Store page
 * on the phone; the line under it names the address to sign in with. The row
 * reads "Connected" once the phone has delivered.
 */
function AppleHealthRow({
  origin,
  connected: isConnected,
}: {
  origin: string;
  connected: boolean;
}) {
  const { t } = useTranslations();
  const [open, setOpen] = useState(false);
  const [qr, setQr] = useState<string | null>(null);

  useEffect(() => {
    if (!open || qr) return;
    let cancelled = false;
    void (async () => {
      try {
        const QRCode = (await import("qrcode")).default;
        const url = await QRCode.toDataURL(IOS_APP_STORE_URL, { margin: 1 });
        if (!cancelled) setQr(url);
      } catch {
        // Best-effort: the address line below works without the picture.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, qr]);

  return (
    <SourceRow
      id="apple-health"
      Icon={Smartphone}
      label={t("onboarding.flow.sources.options.apple-health")}
      hint={t("setup.person.sources.hints.apple-health")}
      action={
        isConnected ? (
          <ConnectedMark />
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-h-11 sm:min-h-9"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
            data-slot="onboarding-source-apple-toggle"
          >
            {t(
              open
                ? "setup.person.sources.hideCode"
                : "setup.person.sources.showCode",
            )}
          </Button>
        )
      }
    >
      {open && !isConnected ? (
        <div
          className="mt-3 flex items-center gap-4"
          data-slot="onboarding-source-apple-pair"
        >
          {qr ? (
            // eslint-disable-next-line @next/next/no-img-element -- a data: URL
            <img
              src={qr}
              alt={t("setup.person.sources.qrAlt")}
              width={96}
              height={96}
              className="size-24 shrink-0 rounded-md bg-white"
            />
          ) : (
            <div className="bg-muted size-24 shrink-0 rounded-md" />
          )}
          <div className="min-w-0 space-y-1 text-sm">
            <p className="font-medium">{t("setup.person.sources.scan")}</p>
            <p className="text-muted-foreground text-xs break-all">
              {t("setup.person.sources.signInWith", { address: origin })}
            </p>
          </div>
        </div>
      ) : null}
    </SourceRow>
  );
}
