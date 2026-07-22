"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  CheckCircle2,
  ClipboardCheck,
  FileUp,
  Plug,
  Watch,
  Wifi,
  type LucideIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  pickStatus,
  useIntegrationStatuses,
} from "@/components/settings/integrations/shared";
import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import { apiPost } from "@/lib/api/api-fetch";
import { localizedApiError } from "@/lib/api/localized-error";
import { queryKeys } from "@/lib/query-keys";

/**
 * Onboarding step 2 (source).
 *
 * Presents the data sources HealthLog ships today. The headline cards
 * cover the two paths most people start on:
 *   1. Manual entry (enabled, recommended — works on any device)
 *   2. Withings — opens OAuth `/api/withings/connect` in a new tab once
 *      the account has its own Withings developer app configured; the
 *      callback flips the connection server-side. Before that, the card
 *      is honest about the prerequisite (v1.29.x, UX audit H1/H2): the
 *      CTA reads "Set up in Settings" and points at the credentials form
 *      instead of launching an OAuth handshake that can only 400.
 *
 * Below them a calm "more sources" row lists the remaining shipped
 * integrations (Apple Health, WHOOP, Oura, Polar, Nightscout, Fitbit),
 * each linking to Settings → Integrations where it is actually
 * connected. We don't try to run six OAuth flows inside the wizard;
 * the row sets the expectation and hands off. A discreet import link
 * points at the Apple Health export.zip path — the cold-start escape
 * hatch for users with existing history.
 *
 * Garmin is omitted: not shipped, so a card would over-claim.
 *
 * Selection is non-binding — Manual is the implicit default and the
 * Next CTA always advances. Nothing here is auto-configured; the step
 * only signposts where each source is connected.
 */

interface SourceCard {
  slug: "manual" | "withings";
  Icon: LucideIcon;
  titleKey: string;
  bodyKey: string;
  /**
   * One of:
   *   - "enabled-select": tap selects the card (Manual)
   *   - "enabled-oauth":  tap opens OAuth in a new tab (Withings)
   */
  state: "enabled-select" | "enabled-oauth";
  /** External href for `enabled-oauth`. */
  href?: string;
  /** Optional recommended badge. */
  recommendedKey?: string;
}

const SOURCE_CARDS: ReadonlyArray<SourceCard> = [
  {
    slug: "manual",
    Icon: ClipboardCheck,
    titleKey: "onboarding.source.manual.title",
    bodyKey: "onboarding.source.manual.body",
    state: "enabled-select",
    recommendedKey: "onboarding.source.recommended",
  },
  {
    slug: "withings",
    Icon: Watch,
    titleKey: "onboarding.source.withings.title",
    bodyKey: "onboarding.source.withings.body",
    state: "enabled-oauth",
    href: "/api/withings/connect",
  },
];

/**
 * The remaining shipped integrations. Listed compactly so the step
 * stays calm — the full connect flow for each lives in Settings.
 */
const MORE_SOURCES: ReadonlyArray<{ slug: string; labelKey: string }> = [
  { slug: "apple-health", labelKey: "onboarding.source.more.appleHealth" },
  { slug: "whoop", labelKey: "onboarding.source.more.whoop" },
  { slug: "oura", labelKey: "onboarding.source.more.oura" },
  { slug: "polar", labelKey: "onboarding.source.more.polar" },
  { slug: "nightscout", labelKey: "onboarding.source.more.nightscout" },
  { slug: "fitbit", labelKey: "onboarding.source.more.fitbit" },
];

export function SourceCardGrid() {
  const { t } = useTranslations();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { isAuthenticated } = useAuth();

  const [selected, setSelected] = useState<SourceCard["slug"]>("manual");
  const [advancing, setAdvancing] = useState(false);

  // v1.29.x — the wizard's "Connect Withings" card must not launch an OAuth
  // handshake that can only fail: Withings credentials are per-user BYO with
  // no env fallback, and a brand-new account never has them yet. Read the
  // same consolidated envelope Settings → Integrations uses so the card
  // knows whether the handshake can actually succeed.
  const { data: integrationStatus } = useIntegrationStatuses(isAuthenticated);
  const withingsConfigured =
    pickStatus(integrationStatus, "withings")?.configured ?? false;
  // 2026-07-17 UX-onboarding audit M6 — the connect CTA opens the OAuth
  // handshake in a new tab; the callback lands THAT tab on
  // Settings → Integrations while this wizard tab never learned the
  // connection succeeded. `useIntegrationStatuses` already refetches on
  // window focus, so returning to this tab after the OAuth round trip
  // picks up the fresh `connected` flag for free — the only missing piece
  // was rendering it as a badge instead of leaving the button looking
  // untouched.
  const withingsConnected =
    pickStatus(integrationStatus, "withings")?.connected ?? false;

  async function advance() {
    if (advancing) return;
    setAdvancing(true);
    try {
      await apiPost("/api/onboarding/step", { step: 3 });
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth() });
      router.push("/onboarding/3");
    } catch (err) {
      toast.error(localizedApiError(err, t, "onboarding.errorGeneric"));
      setAdvancing(false);
    }
  }

  return (
    <section aria-labelledby="onboarding-source-title" className="space-y-6">
      <header className="space-y-2">
        <h1
          id="onboarding-source-title"
          tabIndex={-1}
          className="text-2xl font-semibold tracking-tight"
        >
          {t("onboarding.source.title")}
        </h1>
        <p className="text-muted-foreground text-base leading-relaxed">
          {t("onboarding.source.body")}
        </p>
      </header>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {SOURCE_CARDS.map((card) => (
          <SourceCardItem
            key={card.slug}
            card={card}
            selected={selected === card.slug}
            onSelect={() => setSelected(card.slug)}
            titleLabel={t(card.titleKey)}
            bodyLabel={t(card.bodyKey)}
            recommendedLabel={
              card.recommendedKey ? t(card.recommendedKey) : null
            }
            withingsCtaLabel={t("onboarding.source.withings.cta")}
            withingsConfigured={withingsConfigured}
            withingsConnected={withingsConnected}
            withingsConnectedLabel={t("settings.integrationPill.connected")}
            withingsSetupCtaLabel={t("onboarding.source.withings.setupCta")}
            withingsSetupHint={t("onboarding.source.withings.setupHint")}
          />
        ))}
      </div>

      <div className="border-border space-y-3 rounded-lg border border-dashed p-4">
        <div className="flex items-start gap-3">
          <span
            aria-hidden="true"
            className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-md"
          >
            <Plug className="size-4" />
          </span>
          <div className="min-w-0 flex-1 space-y-1">
            <h2 className="text-base font-semibold tracking-tight">
              {t("onboarding.source.more.title")}
            </h2>
            <p className="text-muted-foreground text-sm leading-relaxed">
              {t("onboarding.source.more.body")}
            </p>
          </div>
        </div>
        <ul className="flex flex-wrap gap-2" data-testid="source-more-list">
          {MORE_SOURCES.map((item) => (
            <li key={item.slug}>
              <Button asChild variant="outline" size="sm" className="min-h-9">
                <Link
                  // Anchor each chip to its provider card so the tap lands on
                  // the card, not the top of the generic Integrations page.
                  // Apple Health has no web card (it syncs from the iOS app),
                  // so its chip stays on the page root.
                  href={
                    item.slug === "apple-health"
                      ? "/settings/integrations"
                      : `/settings/integrations#${item.slug}`
                  }
                  data-testid={`source-more-${item.slug}`}
                >
                  {t(item.labelKey)}
                </Link>
              </Button>
            </li>
          ))}
        </ul>
      </div>

      <Link
        href="/settings/export"
        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-sm underline-offset-4 hover:underline"
        data-testid="source-import-link"
      >
        <FileUp className="size-3.5" />
        {t("onboarding.source.import")}
      </Link>

      <div className="flex items-center justify-between gap-2 pt-2">
        <Button asChild variant="ghost" className="min-h-11 min-w-11">
          <Link href="/onboarding/1">{t("onboarding.shell.back")}</Link>
        </Button>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={advance}
            disabled={advancing}
            className="min-h-11 min-w-11"
          >
            {t("onboarding.shell.skip")}
          </Button>
          <Button
            type="button"
            onClick={advance}
            disabled={advancing}
            className="min-h-11 min-w-11"
          >
            {t("onboarding.shell.next")}
          </Button>
        </div>
      </div>
    </section>
  );
}

interface SourceCardItemProps {
  card: SourceCard;
  selected: boolean;
  onSelect: () => void;
  titleLabel: string;
  bodyLabel: string;
  recommendedLabel: string | null;
  withingsCtaLabel: string;
  /** Whether the account already has its own Withings developer-app
   *  credentials saved — i.e. whether `/api/withings/connect` can
   *  actually succeed right now. */
  withingsConfigured: boolean;
  /** Whether Withings is already connected (OAuth completed in the tab the
   *  connect CTA opened). Replaces the connect button with a badge so
   *  returning to this wizard tab shows the outcome instead of an
   *  unchanged card. */
  withingsConnected: boolean;
  /** Localised "Connected" label for the badge above. */
  withingsConnectedLabel: string;
  /** CTA label shown instead of "Connect Withings" when unconfigured. */
  withingsSetupCtaLabel: string;
  /** One-sentence explanation of the BYO credential prerequisite. */
  withingsSetupHint: string;
}

function SourceCardItem({
  card,
  selected,
  onSelect,
  titleLabel,
  bodyLabel,
  recommendedLabel,
  withingsCtaLabel,
  withingsConfigured,
  withingsConnected,
  withingsConnectedLabel,
  withingsSetupCtaLabel,
  withingsSetupHint,
}: SourceCardItemProps) {
  const Icon = card.Icon;

  const baseClasses = cn(
    "relative flex flex-col gap-3 rounded-lg border p-4 text-left transition-colors duration-150 ease-out motion-reduce:transition-none",
    "bg-card border-border",
  );

  const headerRow = (
    <div className="flex items-start gap-3">
      <span
        aria-hidden="true"
        className={cn(
          "flex size-10 shrink-0 items-center justify-center rounded-md",
          selected
            ? "bg-primary text-primary-foreground"
            : "bg-muted text-muted-foreground",
        )}
      >
        <Icon className="size-5" />
      </span>
      <div className="min-w-0 flex-1">
        <h2 className="text-base font-semibold tracking-tight">{titleLabel}</h2>
        {recommendedLabel ? (
          <span className="bg-primary/10 text-primary mt-1 inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium tracking-wide uppercase">
            {recommendedLabel}
          </span>
        ) : null}
      </div>
    </div>
  );

  const body = (
    <p className="text-muted-foreground text-sm leading-relaxed">{bodyLabel}</p>
  );

  if (card.state === "enabled-oauth") {
    return (
      <div
        className={cn(
          baseClasses,
          selected && "border-primary bg-primary/5",
          "hover:border-primary/50 focus-within:border-primary/50",
        )}
        data-testid={`source-card-${card.slug}`}
      >
        {headerRow}
        {body}
        {withingsConnected ? (
          <div
            className="text-primary flex items-center gap-1.5 pt-1 text-sm font-medium"
            data-testid="source-card-withings-connected"
          >
            <CheckCircle2 className="size-3.5" aria-hidden="true" />
            {withingsConnectedLabel}
          </div>
        ) : withingsConfigured ? (
          <div className="flex items-center gap-2 pt-1">
            <Button asChild variant="outline" size="sm">
              <a
                href={card.href}
                target="_blank"
                rel="noopener"
                onClick={onSelect}
                className="inline-flex items-center gap-1.5"
              >
                <Wifi className="size-3.5" />
                {withingsCtaLabel}
              </a>
            </Button>
          </div>
        ) : (
          // No per-user Withings credentials yet — an OAuth handshake here
          // can only 400 (Withings has no env fallback). Point at the
          // credentials form instead of launching a doomed connect flow.
          <div className="space-y-2 pt-1">
            <p className="text-muted-foreground text-xs">{withingsSetupHint}</p>
            <Button asChild variant="outline" size="sm">
              <Link
                href="/settings/integrations#withings"
                onClick={onSelect}
                className="inline-flex items-center gap-1.5"
                data-testid="source-card-withings-setup"
              >
                <Wifi className="size-3.5" />
                {withingsSetupCtaLabel}
              </Link>
            </Button>
          </div>
        )}
      </div>
    );
  }

  // enabled-select (Manual)
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        baseClasses,
        "hover:border-primary/50 cursor-pointer",
        selected && "border-primary bg-primary/5",
      )}
      data-testid={`source-card-${card.slug}`}
    >
      {headerRow}
      {body}
    </button>
  );
}
