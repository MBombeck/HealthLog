"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Apple,
  ClipboardCheck,
  Watch,
  Wifi,
  type LucideIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { useTranslations } from "@/lib/i18n/context";
import { readError } from "@/lib/api/read-error";
import { cn } from "@/lib/utils";

/**
 * v1.4.25 W14b-Content — onboarding step 2 (source).
 *
 * Four-card grid presenting the data sources HealthLog supports today
 * plus the announce-only Apple Health card so users land on v1.5 with
 * the right expectation.
 *
 * Cards:
 *   1. Manual entry (enabled, recommended)
 *   2. Withings (enabled — opens OAuth `/api/withings/connect` in a new
 *      tab; the popup hands control back via the existing callback)
 *   3. Apple Health (DISABLED — "Coming with v1.5 iOS app")
 *   4. Garmin — omitted entirely. Not on the v1.5 roadmap so showing
 *      a disabled card adds noise without conveying a real promise.
 *
 * Selection is non-binding — Manual is the implicit default and the
 * Next CTA always advances. The Withings card opens the OAuth flow in
 * a new tab; the user returns to this step to click Next when they're
 * back (callback handler flips the connection server-side, no client
 * polling needed for the wizard contract).
 */

interface SourceCard {
  slug: "manual" | "withings" | "apple-health";
  Icon: LucideIcon;
  titleKey: string;
  bodyKey: string;
  /**
   * One of:
   *   - "enabled-select": tap selects the card (Manual)
   *   - "enabled-oauth":  tap opens OAuth in a new tab (Withings)
   *   - "disabled":       semi-transparent, badge, no-op (Apple Health)
   */
  state: "enabled-select" | "enabled-oauth" | "disabled";
  /** External href for `enabled-oauth`. */
  href?: string;
  /** Optional badge under the title (e.g. "Coming with v1.5"). */
  badgeKey?: string;
  /** Optional recommended badge ("Most popular"). */
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
  {
    slug: "apple-health",
    Icon: Apple,
    titleKey: "onboarding.source.appleHealth.title",
    bodyKey: "onboarding.source.appleHealth.body",
    state: "disabled",
    badgeKey: "onboarding.source.appleHealth.badge",
  },
];

export function SourceCardGrid() {
  const { t } = useTranslations();
  const router = useRouter();
  const queryClient = useQueryClient();

  const [selected, setSelected] = useState<SourceCard["slug"]>("manual");
  const [advancing, setAdvancing] = useState(false);

  async function advance() {
    if (advancing) return;
    setAdvancing(true);
    try {
      const res = await fetch("/api/onboarding/step", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ step: 3 }),
      });
      if (!res.ok) throw new Error(await readError(res));
      await queryClient.invalidateQueries({ queryKey: ["auth"] });
      router.push("/onboarding/3");
    } catch (err) {
      const message =
        err instanceof Error ? err.message : t("onboarding.errorGeneric");
      toast.error(message);
      setAdvancing(false);
    }
  }

  return (
    <section
      aria-labelledby="onboarding-source-title"
      className="space-y-6"
    >
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
            badgeLabel={card.badgeKey ? t(card.badgeKey) : null}
            withingsCtaLabel={t("onboarding.source.withings.cta")}
            disabledHintLabel={t("onboarding.source.appleHealth.disabledHint")}
          />
        ))}
      </div>

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
  badgeLabel: string | null;
  withingsCtaLabel: string;
  disabledHintLabel: string;
}

function SourceCardItem({
  card,
  selected,
  onSelect,
  titleLabel,
  bodyLabel,
  recommendedLabel,
  badgeLabel,
  withingsCtaLabel,
  disabledHintLabel,
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
          selected && card.state !== "disabled"
            ? "bg-primary text-primary-foreground"
            : "bg-muted text-muted-foreground",
        )}
      >
        <Icon className="size-5" />
      </span>
      <div className="min-w-0 flex-1">
        <h2 className="text-base font-semibold tracking-tight">{titleLabel}</h2>
        {badgeLabel ? (
          <span
            className="bg-muted text-muted-foreground mt-1 inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide"
            data-testid={`source-badge-${card.slug}`}
          >
            {badgeLabel}
          </span>
        ) : recommendedLabel ? (
          <span className="bg-primary/10 text-primary mt-1 inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide">
            {recommendedLabel}
          </span>
        ) : null}
      </div>
    </div>
  );

  const body = (
    <p className="text-muted-foreground text-sm leading-relaxed">{bodyLabel}</p>
  );

  if (card.state === "disabled") {
    return (
      <div
        aria-disabled="true"
        className={cn(baseClasses, "cursor-not-allowed opacity-60")}
        data-testid={`source-card-${card.slug}`}
      >
        {headerRow}
        {body}
        <p className="text-muted-foreground text-xs italic">
          {disabledHintLabel}
        </p>
      </div>
    );
  }

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
        "cursor-pointer hover:border-primary/50",
        selected && "border-primary bg-primary/5",
      )}
      data-testid={`source-card-${card.slug}`}
    >
      {headerRow}
      {body}
    </button>
  );
}

