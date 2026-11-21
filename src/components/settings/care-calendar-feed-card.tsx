"use client";

/**
 * The care calendar subscription: booked visits, check-ups and vaccination
 * boosters coming due, in the calendar app the person already uses.
 *
 * Built like the cycle feed's card (`cycle-calendar-feed-card.tsx`) and
 * sharing its wording where the wording is the same. Off by default, and the
 * disclosure comes before the button: a calendar provider keeps what it
 * fetched. The link is shown once, right after it is made; after that the
 * card knows only its prefix. A new link is off and on again.
 */
import { useState } from "react";
import { CalendarSync, Loader2 } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import {
  recentProofErrorMessage,
  useRecentProof,
} from "@/components/settings/security-section/use-recent-proof";
import { apiDelete, apiGet, apiPatch, apiPost } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import { formatRelativeTime } from "@/lib/i18n/relative-time";
import { queryKeys } from "@/lib/query-keys";

type TitleMode = "DISCREET" | "DESCRIPTIVE";

interface CareFeedSummary {
  tokenPrefix: string;
  lastFetchedAt: string | null;
  lastFetcher: "GOOGLE" | "APPLE" | "MICROSOFT" | "OTHER" | null;
  includeVisits: boolean;
  includeCheckups: boolean;
  includeVaccinations: boolean;
  titleMode: TitleMode;
}

interface CareFeedMinted {
  url: string;
  webcalUrl: string;
}

type OptionsPatch = Partial<
  Pick<
    CareFeedSummary,
    "includeVisits" | "includeCheckups" | "includeVaccinations" | "titleMode"
  >
>;

const PATH = "/api/care/feed-subscription";
const KEY = queryKeys.careFeedSubscription();

const TOGGLES = [
  { field: "includeVisits", label: "careFeed.visits" },
  { field: "includeCheckups", label: "careFeed.checkups" },
  { field: "includeVaccinations", label: "careFeed.vaccinations" },
] as const;

export function CareCalendarFeedCard() {
  const { t } = useTranslations();
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: KEY });
  const status = useQuery({
    queryKey: KEY,
    queryFn: () => apiGet<{ feed: CareFeedSummary | null }>(PATH),
    staleTime: 60_000,
  });
  const proof = useRecentProof();
  const mint = useMutation({
    mutationKey: KEY,
    mutationFn: () =>
      proof.run(() => apiPost<CareFeedMinted>("/api/care/feed-subscription")),
    onSettled: invalidate,
  });
  const update = useMutation({
    mutationKey: KEY,
    mutationFn: (patch: OptionsPatch) => apiPatch(PATH, patch),
    onSettled: invalidate,
  });
  const revoke = useMutation({
    mutationKey: KEY,
    mutationFn: () => apiDelete(PATH),
    onSettled: invalidate,
  });
  const [minted, setMinted] = useState<CareFeedMinted | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function turnOn() {
    setError(null);
    try {
      setMinted(await mint.mutateAsync());
    } catch (err) {
      setError(recentProofErrorMessage(err, t("cycle.feed.error")));
    }
  }

  const feed = status.data?.feed;
  return (
    <SettingsCard data-slot="care-calendar-feed">
      <SettingsCardHeader
        icon={CalendarSync}
        title={t("careFeed.title")}
        description={t("careFeed.description")}
      />
      {status.isError ? (
        <QueryErrorCard
          error={status.error}
          title={t("careFeed.loadError")}
          onRetry={() => void status.refetch()}
        />
      ) : status.isLoading || !status.data ? (
        <div className="flex h-16 items-center justify-center">
          <Loader2 className="text-muted-foreground size-5 animate-spin motion-reduce:animate-none" />
        </div>
      ) : !feed ? (
        <>
          <p className="text-sm">{t("cycle.feed.disclosure")}</p>
          <SettingsCardActions>
            <Button
              size="sm"
              className="min-h-11 w-full sm:w-auto"
              onClick={() => void turnOn()}
              disabled={mint.isPending}
            >
              {mint.isPending ? (
                <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
              ) : null}
              {t("cycle.feed.turnOn")}
            </Button>
          </SettingsCardActions>
        </>
      ) : (
        <>
          {minted ? (
            <LinkPanel minted={minted} />
          ) : (
            <p className="text-muted-foreground text-sm">
              {t("careFeed.linkHidden", { prefix: feed.tokenPrefix })}
            </p>
          )}
          <FetchLine feed={feed} />
          <Separator />
          {TOGGLES.map(({ field, label }) => (
            <div
              key={field}
              className="flex items-center justify-between gap-4"
            >
              <Label htmlFor={`care-feed-${field}`} className="text-sm">
                {t(label)}
              </Label>
              <Switch
                id={`care-feed-${field}`}
                checked={feed[field]}
                disabled={update.isPending}
                onCheckedChange={(v) => update.mutate({ [field]: v })}
              />
            </div>
          ))}
          <div className="space-y-1.5">
            <Label htmlFor="care-feed-title">{t("cycle.feed.titles")}</Label>
            <NativeSelect
              id="care-feed-title"
              value={feed.titleMode}
              disabled={update.isPending}
              onChange={(e) =>
                update.mutate({ titleMode: e.target.value as TitleMode })
              }
            >
              <option value="DISCREET">
                {t("cycle.feed.titleMode.DISCREET")}
              </option>
              <option value="DESCRIPTIVE">
                {t("cycle.feed.titleMode.DESCRIPTIVE")}
              </option>
            </NativeSelect>
          </div>
          <div className="space-y-1.5">
            <p className="text-sm font-medium">{t("cycle.feed.help.title")}</p>
            <ul className="text-muted-foreground list-disc space-y-1 pl-5 text-sm">
              <li>{t("cycle.feed.help.google")}</li>
              <li>{t("cycle.feed.help.apple")}</li>
              <li>{t("cycle.feed.help.outlook")}</li>
            </ul>
          </div>
          <SettingsCardActions>
            <ConfirmButton
              label={t("cycle.feed.turnOff")}
              title={t("cycle.feed.turnOffTitle")}
              body={t("cycle.feed.turnOffBody")}
              confirmLabel={t("cycle.feed.turnOff")}
              onConfirm={() =>
                revoke.mutate(undefined, { onSuccess: () => setMinted(null) })
              }
              pending={revoke.isPending}
              variant="destructive"
              destructive
              size="sm"
              className="min-h-11 w-full sm:w-auto"
            />
          </SettingsCardActions>
        </>
      )}
      {error || update.isError || revoke.isError ? (
        <p className="text-destructive text-sm" role="alert">
          {error ?? t("cycle.feed.error")}
        </p>
      ) : null}
      {proof.dialog}
    </SettingsCard>
  );
}

/** The link, the one time it exists in the client. */
function LinkPanel({ minted }: { minted: CareFeedMinted }) {
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
    <div className="space-y-3" data-slot="care-feed-link">
      <div className="space-y-1.5">
        <Label htmlFor="care-feed-url">{t("cycle.feed.linkLabel")}</Label>
        <code
          id="care-feed-url"
          className="bg-muted block rounded-md px-3 py-2 text-sm break-all"
        >
          {minted.url}
        </code>
        <p className="text-muted-foreground text-xs">
          {t("careFeed.linkOnce")}
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

function FetchLine({ feed }: { feed: CareFeedSummary }) {
  const { t, locale } = useTranslations();
  if (feed.lastFetchedAt === null) {
    return (
      <p className="text-muted-foreground text-sm">
        {t("cycle.feed.notFetched")}
      </p>
    );
  }
  return (
    <p className="text-muted-foreground text-sm">
      {t("cycle.feed.lastFetched", {
        when: formatRelativeTime(feed.lastFetchedAt, t, locale),
        fetcher: t(`cycle.feed.fetcher.${feed.lastFetcher ?? "OTHER"}`),
      })}
    </p>
  );
}
