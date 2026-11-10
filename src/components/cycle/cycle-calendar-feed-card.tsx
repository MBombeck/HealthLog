"use client";

import { useState } from "react";
import { CalendarSync, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import {
  recentProofErrorMessage,
  useRecentProof,
} from "@/components/settings/security-section/use-recent-proof";
import { formatRelativeTime } from "@/lib/i18n/relative-time";
import { useTranslations } from "@/lib/i18n/context";

import {
  useCycleFeedStatus,
  useMintCycleFeed,
  useRevokeCycleFeed,
  useUpdateCycleFeed,
  type CycleFeedMinted,
  type CycleFeedOptionsPatch,
  type CycleFeedStatus,
  type FeedForecastStyle,
  type FeedTitleMode,
} from "./use-cycle-feed";

/**
 * #1350 — the calendar subscription card on the cycle settings tab.
 *
 * Off by default, and the disclosure comes before the button: a calendar
 * provider keeps what it fetched, and turning the link off later reaches none
 * of it. The link itself is shown once, right after it is made; after that the
 * card knows only its prefix. Rendered only for the owner and a MANAGE
 * delegate (the tab's own gate); the routes refuse everyone else regardless.
 */

const HORIZONS = [1, 3, 6] as const;
const HISTORIES = [0, 3, 6, 12] as const;
const TITLE_MODES: FeedTitleMode[] = ["DISCREET", "DESCRIPTIVE"];
const FORECAST_STYLES: FeedForecastStyle[] = ["EXACT", "MARGIN", "BAND"];

/** A long URL with its middle elided, so both ends stay recognisable. */
function middleTruncate(url: string, keep = 28): string {
  return url.length <= keep * 2 + 1
    ? url
    : `${url.slice(0, keep)}…${url.slice(-keep / 2)}`;
}

export function CycleCalendarFeedCard() {
  const { t } = useTranslations();
  const status = useCycleFeedStatus();
  const proof = useRecentProof();
  const mint = useMintCycleFeed(proof);
  const [minted, setMinted] = useState<CycleFeedMinted | null>(null);
  const [mintError, setMintError] = useState<string | null>(null);

  async function handleMint(kind: "create" | "rotate") {
    setMintError(null);
    try {
      setMinted(await mint.mutateAsync(kind));
    } catch (err) {
      setMintError(recentProofErrorMessage(err, t("cycle.feed.error")));
    }
  }

  return (
    <SettingsCard data-slot="cycle-calendar-feed">
      <SettingsCardHeader
        icon={CalendarSync}
        title={t("cycle.feed.title")}
        description={t("cycle.feed.description")}
      />
      {status.isError ? (
        <QueryErrorCard
          error={status.error}
          title={t("cycle.loadError")}
          onRetry={() => void status.refetch()}
        />
      ) : status.isLoading || !status.data ? (
        <div className="flex h-16 items-center justify-center">
          <Loader2 className="text-muted-foreground h-5 w-5 animate-spin motion-reduce:animate-none" />
        </div>
      ) : status.data.feed === null ? (
        <OffState
          pending={mint.isPending}
          error={mintError}
          onTurnOn={() => void handleMint("create")}
        />
      ) : (
        <OnState
          status={status.data}
          minted={minted}
          pending={mint.isPending}
          error={mintError}
          onRotate={() => void handleMint("rotate")}
          onRevoked={() => setMinted(null)}
        />
      )}
      {proof.dialog}
    </SettingsCard>
  );
}

function OffState({
  pending,
  error,
  onTurnOn,
}: {
  pending: boolean;
  error: string | null;
  onTurnOn: () => void;
}) {
  const { t } = useTranslations();
  return (
    <>
      <p className="text-sm">{t("cycle.feed.disclosure")}</p>
      {error ? (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}
      <SettingsCardActions>
        <Button
          size="sm"
          className="min-h-11 w-full sm:w-auto"
          onClick={onTurnOn}
          disabled={pending}
        >
          {pending ? (
            <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
          ) : null}
          {t("cycle.feed.turnOn")}
        </Button>
      </SettingsCardActions>
    </>
  );
}

function OnState({
  status,
  minted,
  pending,
  error,
  onRotate,
  onRevoked,
}: {
  status: CycleFeedStatus;
  minted: CycleFeedMinted | null;
  pending: boolean;
  error: string | null;
  onRotate: () => void;
  onRevoked: () => void;
}) {
  const { t } = useTranslations();
  const revoke = useRevokeCycleFeed();
  const feed = status.feed!;
  const state = status.projectionState;

  return (
    <>
      {minted ? (
        <LinkPanel minted={minted} />
      ) : (
        <p className="text-muted-foreground text-sm">
          {t("cycle.feed.linkHidden", { prefix: feed.tokenPrefix })}
        </p>
      )}
      <FetchLine status={status} />
      {state === "LEARNING" || state === "LATE" || state === "OFF" ? (
        <p
          className="text-muted-foreground text-sm"
          data-slot="cycle-feed-state"
        >
          {t(`cycle.projection.state.${state}`)}
        </p>
      ) : null}
      <Separator />
      <FeedOptions status={status} />
      <HelpList />
      {error || revoke.isError ? (
        <p className="text-destructive text-sm" role="alert">
          {error ?? t("cycle.feed.error")}
        </p>
      ) : null}
      <SettingsCardActions className="flex-col items-stretch sm:flex-row sm:items-center">
        <ConfirmButton
          label={t("cycle.feed.turnOff")}
          title={t("cycle.feed.turnOffTitle")}
          body={t("cycle.feed.turnOffBody")}
          confirmLabel={t("cycle.feed.turnOff")}
          onConfirm={() => revoke.mutate(undefined, { onSuccess: onRevoked })}
          pending={revoke.isPending}
          variant="destructive"
          destructive
          size="sm"
          className="min-h-11 w-full sm:w-auto"
        />
        <ConfirmButton
          label={t("cycle.feed.rotate")}
          title={t("cycle.feed.rotateTitle")}
          body={t("cycle.feed.rotateBody")}
          confirmLabel={t("cycle.feed.rotate")}
          onConfirm={onRotate}
          pending={pending}
          size="sm"
          className="min-h-11 w-full sm:w-auto"
        />
      </SettingsCardActions>
    </>
  );
}

/** The link, the one time it exists in the client. */
function LinkPanel({ minted }: { minted: CycleFeedMinted }) {
  const { t } = useTranslations();
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(minted.url);
      setCopy("copied");
    } catch {
      setCopy("failed");
    }
  }

  return (
    <div className="space-y-3" data-slot="cycle-feed-link">
      <div className="space-y-1.5">
        <Label htmlFor="cycle-feed-url">{t("cycle.feed.linkLabel")}</Label>
        <code
          id="cycle-feed-url"
          className="bg-muted block rounded-md px-3 py-2 text-sm break-all"
          title={minted.url}
        >
          {middleTruncate(minted.url)}
        </code>
        <p className="text-muted-foreground text-xs">
          {t("cycle.feed.linkOnce")}
        </p>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button
          variant="outline"
          size="sm"
          className="min-h-11 w-full sm:w-auto"
          onClick={() => void handleCopy()}
        >
          {t("cycle.feed.copy")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          asChild
          className="min-h-11 w-full sm:w-auto"
        >
          <a href={minted.webcalUrl}>{t("cycle.feed.openInCalendar")}</a>
        </Button>
      </div>
      <p className="text-muted-foreground text-sm" aria-live="polite">
        {copy === "copied"
          ? t("cycle.feed.copied")
          : copy === "failed"
            ? t("cycle.feed.copyFailed")
            : ""}
      </p>
    </div>
  );
}

function FetchLine({ status }: { status: CycleFeedStatus }) {
  const { t, locale } = useTranslations();
  const feed = status.feed!;
  if (feed.lastFetchedAt === null) {
    return (
      <p className="text-muted-foreground text-sm">
        {t("cycle.feed.notFetched")}
      </p>
    );
  }
  const when = formatRelativeTime(feed.lastFetchedAt, t, locale);
  return (
    <p className="text-muted-foreground text-sm">
      {t("cycle.feed.lastFetched", {
        when,
        fetcher: t(`cycle.feed.fetcher.${feed.lastFetcher ?? "OTHER"}`),
      })}
    </p>
  );
}

function FeedOptions({ status }: { status: CycleFeedStatus }) {
  const { t } = useTranslations();
  const update = useUpdateCycleFeed();
  const feed = status.feed!;
  const save = (patch: CycleFeedOptionsPatch) => update.mutate(patch);

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor="cycle-feed-horizon">{t("cycle.feed.horizon")}</Label>
          <NativeSelect
            id="cycle-feed-horizon"
            value={String(feed.horizonCycles)}
            disabled={update.isPending}
            onChange={(e) => save({ horizonCycles: Number(e.target.value) })}
          >
            {HORIZONS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="cycle-feed-history">{t("cycle.feed.history")}</Label>
          <NativeSelect
            id="cycle-feed-history"
            value={String(feed.historyCycles)}
            disabled={update.isPending}
            onChange={(e) => save({ historyCycles: Number(e.target.value) })}
          >
            {HISTORIES.map((n) => (
              <option key={n} value={n}>
                {n === 0 ? t("cycle.feed.historyNone") : n}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="cycle-feed-title">{t("cycle.feed.titles")}</Label>
          <NativeSelect
            id="cycle-feed-title"
            value={feed.titleMode}
            disabled={update.isPending}
            onChange={(e) =>
              save({ titleMode: e.target.value as FeedTitleMode })
            }
          >
            {TITLE_MODES.map((m) => (
              <option key={m} value={m}>
                {t(`cycle.feed.titleMode.${m}`)}
              </option>
            ))}
          </NativeSelect>
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="cycle-feed-forecast">{t("cycle.feed.forecasts")}</Label>
        <NativeSelect
          id="cycle-feed-forecast"
          value={feed.forecastStyle}
          disabled={update.isPending}
          aria-describedby="cycle-feed-forecast-hint"
          onChange={(e) =>
            save({ forecastStyle: e.target.value as FeedForecastStyle })
          }
        >
          {FORECAST_STYLES.map((s) => (
            <option key={s} value={s}>
              {t(`cycle.feed.forecastStyle.${s}`)}
            </option>
          ))}
        </NativeSelect>
        <p
          id="cycle-feed-forecast-hint"
          className="text-muted-foreground text-sm"
          data-slot="cycle-feed-forecast-hint"
        >
          {t(`cycle.feed.forecastStyleHint.${feed.forecastStyle}`)}
        </p>
      </div>
      {status.fertileAvailable ? (
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-0.5">
            <Label htmlFor="cycle-feed-fertile" className="text-sm">
              {t("cycle.feed.fertile")}
            </Label>
            <p className="text-muted-foreground text-sm">
              {t("cycle.feed.fertileDescription")}
            </p>
          </div>
          <Switch
            id="cycle-feed-fertile"
            checked={feed.includeFertile}
            disabled={update.isPending}
            onCheckedChange={(v) => save({ includeFertile: v })}
            className="mt-0.5 shrink-0"
          />
        </div>
      ) : null}
      {update.isError ? (
        <p className="text-destructive text-sm" role="alert">
          {t("cycle.feed.error")}
        </p>
      ) : null}
    </div>
  );
}

function HelpList() {
  const { t } = useTranslations();
  return (
    <div className="space-y-1.5">
      <p className="text-sm font-medium">{t("cycle.feed.help.title")}</p>
      <ul className="text-muted-foreground list-disc space-y-1 pl-5 text-sm">
        <li>{t("cycle.feed.help.google")}</li>
        <li>{t("cycle.feed.help.apple")}</li>
        <li>{t("cycle.feed.help.outlook")}</li>
      </ul>
    </div>
  );
}
