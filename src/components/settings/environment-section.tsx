"use client";

/**
 * `<EnvironmentSection>` — Settings → Environment (v1.25, W-ENV).
 *
 * The one surface for the opt-in environmental-context module: pick a coarse
 * home location (city search → rounded lat/lon, never a GPS track), declare
 * travel overrides that win over home for their date range, and trigger a
 * backfill of past days. The nightly job keeps recent days current; the
 * correlation engine then surfaces e.g. "daylight ↔ mood" on its own.
 *
 * State source for the enabled flag is `useAuth().user.modules.environment`
 * (the resolved /auth/me map). When the module is off the section nudges the
 * user to the Modules hub rather than rendering dead controls. All reads unwrap
 * `(await res.json()).data` via the api-fetch helpers; every key routes through
 * the centralized factory.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CloudSun, MapPin, Plane, Trash2, Wind } from "lucide-react";

import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/hooks/use-auth";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { formatDateTime } from "@/lib/format";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import {
  apiDelete,
  apiGet,
  apiPatch,
  apiPost,
  apiPut,
} from "@/lib/api/api-fetch";
import { pollenMax, type PollenByKind } from "@/lib/environment/day-flags";
import { queryKeys } from "@/lib/query-keys";
import {
  DEFAULT_TIMEZONE,
  detectBrowserTimezone,
  userDayKey,
  validTimezoneOr,
} from "@/lib/tz/format";

interface GeocodeResult {
  lat: number;
  lon: number;
  label: string;
  timezone: string;
}

interface TravelDTO {
  id: string;
  startDate: string;
  endDate: string;
  lat: number;
  lon: number;
  label: string;
}

interface EnvironmentOverview {
  home: {
    lat: number;
    lon: number;
    label: string | null;
    timezone: string;
    /** ISO instant the home became effective (drives the conservative backfill
     * default + the "tracked since" label). */
    since: string | null;
  } | null;
  travel: TravelDTO[];
  context: {
    days: number;
    latestDate: string | null;
    latestFetchedAt: string | null;
  };
  /** Set when the background weather fetch for this account recently gave up.
   * A zero day count alone cannot distinguish "nothing to store yet" from
   * "every run failed", so the count is never rendered on its own. */
  lastFetchFailure: { lastFailedAt: string; failures: number } | null;
  attribution: string;
  /** v1.42 — the air-quality part: switches and coverage. */
  airQuality: {
    enabled: boolean;
    operatorDisabled: boolean;
    days: number;
    latestDate: string | null;
    domain: string | null;
    /** The history backfill's progress; null before its first run. */
    history: {
      total: number;
      done: number;
      complete: boolean;
      checkedAt: string;
    } | null;
  };
  /** v1.42 — the newest stored day; `airQuality` null while off/unfetched. */
  latestDay: {
    date: string;
    tempMin: number | null;
    tempMax: number | null;
    apparentMax: number | null;
    airQuality: {
      pm25Mean: number | null;
      pm10Mean: number | null;
      no2Mean: number | null;
      o3Max8h: number | null;
      eaqiMax: number | null;
      uvIndexMax: number | null;
      dustMax: number | null;
      pollen: PollenByKind;
    } | null;
  } | null;
  /** v1.42 — every attribution line, weather first. */
  attributions: string[];
}

/** One value of the newest day, or a dash when the feed did not cover it. */
function envValue(value: number | null, unit: string, digits = 0): string {
  if (value == null) return "–";
  const rounded = Number(value.toFixed(digits));
  return unit ? `${rounded} ${unit}` : String(rounded);
}

export function EnvironmentSection() {
  const { t, tCount } = useTranslations();
  const fmt = useFormatters();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  // Date defaults are the user's own days. The UTC day was tomorrow for
  // anyone east of UTC in the small hours and yesterday west of it in the
  // evening.
  const tz = validTimezoneOr(
    user?.timezone ?? detectBrowserTimezone(),
    DEFAULT_TIMEZONE,
  );
  const todayKey = () => userDayKey(new Date(), tz);

  const enabled = user?.modules?.environment === true;

  const overview = useQuery({
    queryKey: queryKeys.environment(),
    enabled,
    queryFn: () => apiGet<EnvironmentOverview>("/api/environment"),
  });

  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: queryKeys.environment() });

  // ── geocoding search (shared by home + travel pickers) ──────────────────
  const [homeQuery, setHomeQuery] = useState("");
  const [homeResults, setHomeResults] = useState<GeocodeResult[]>([]);
  // Tracks whether a geocode has completed for the current query so a
  // zero-result search can surface a "no matches" line instead of silence.
  const [homeSearched, setHomeSearched] = useState(false);
  const [travelQuery, setTravelQuery] = useState("");
  const [travelResults, setTravelResults] = useState<GeocodeResult[]>([]);
  const [travelSearched, setTravelSearched] = useState(false);
  const [travelLoc, setTravelLoc] = useState<GeocodeResult | null>(null);
  const [travelStart, setTravelStart] = useState(todayKey());
  const [travelEnd, setTravelEnd] = useState(todayKey());
  const [backfillStart, setBackfillStart] = useState("");
  const [backfillEnd, setBackfillEnd] = useState(todayKey());

  const geocode = (query: string) =>
    apiGet<{ results: GeocodeResult[] }>(
      `/api/environment/geocode?q=${encodeURIComponent(query)}`,
    );

  const searchHome = useMutation({
    mutationKey: queryKeys.environmentGeocode("home"),
    mutationFn: () => geocode(homeQuery),
    onSuccess: (data) => {
      setHomeResults(data.results);
      setHomeSearched(true);
    },
    onError: () => toast.error(t("settings.sections.environment.searchError")),
  });

  const searchTravel = useMutation({
    mutationKey: queryKeys.environmentGeocode("travel"),
    mutationFn: () => geocode(travelQuery),
    onSuccess: (data) => {
      setTravelResults(data.results);
      setTravelSearched(true);
    },
    onError: () => toast.error(t("settings.sections.environment.searchError")),
  });

  const setHome = useMutation({
    mutationKey: queryKeys.environment(),
    mutationFn: (loc: GeocodeResult) =>
      apiPut("/api/environment/home", {
        lat: loc.lat,
        lon: loc.lon,
        label: loc.label,
        timezone: loc.timezone,
      }),
    onSuccess: () => {
      setHomeResults([]);
      setHomeQuery("");
      setHomeSearched(false);
      invalidate();
      toast.success(t("settings.sections.environment.homeSaved"));
    },
    onError: () => toast.error(t("settings.sections.environment.saveError")),
  });

  const addTravel = useMutation({
    mutationKey: queryKeys.environment(),
    mutationFn: () =>
      apiPost("/api/environment/travel", {
        startDate: travelStart,
        endDate: travelEnd,
        lat: travelLoc!.lat,
        lon: travelLoc!.lon,
        label: travelLoc!.label,
      }),
    onSuccess: () => {
      setTravelLoc(null);
      setTravelResults([]);
      setTravelQuery("");
      setTravelSearched(false);
      invalidate();
      toast.success(t("settings.sections.environment.travelAdded"));
    },
    onError: () => toast.error(t("settings.sections.environment.saveError")),
  });

  const removeTravel = useMutation({
    mutationKey: queryKeys.environment(),
    mutationFn: (id: string) => apiDelete(`/api/environment/travel/${id}`),
    onSuccess: () => {
      invalidate();
      toast.success(t("settings.sections.environment.travelRemoved"));
    },
    onError: () => toast.error(t("settings.sections.environment.saveError")),
  });

  const setAirQuality = useMutation({
    mutationKey: queryKeys.environment(),
    mutationFn: (airQualityEnabled: boolean) =>
      apiPatch("/api/environment/preferences", { airQualityEnabled }),
    // The switch itself shows the new state; no toast on success.
    onSuccess: () => invalidate(),
    onError: () =>
      toast.error(t("settings.sections.environment.airQuality.saveError")),
  });

  const backfill = useMutation({
    mutationKey: queryKeys.environment(),
    mutationFn: (startDate: string) =>
      apiPost("/api/environment/backfill", {
        startDate,
        endDate: backfillEnd,
      }),
    onSuccess: () => {
      invalidate();
      toast.success(t("settings.sections.environment.backfillQueued"));
    },
    onError: () =>
      toast.error(t("settings.sections.environment.backfillError")),
  });

  if (!enabled) {
    return (
      <SettingsCard>
        <SettingsCardHeader
          icon={CloudSun}
          title={t("settings.sections.environment.title")}
        />
        <p className="text-muted-foreground text-sm leading-relaxed">
          {t("settings.sections.environment.disabledHint")}
        </p>
      </SettingsCard>
    );
  }

  const data = overview.data;
  const home = data?.home ?? null;
  // Conservative default: backfill starts at the home's effective-from date. The
  // user can still type an earlier start, but pre-home days resolve to SKIP on
  // the server — to fill the deep past they add an explicit location period.
  const effectiveBackfillStart =
    // `since` stays on the server's day for the home (a UTC day key in the
    // environment module), so the default start matches what the worker
    // compares against.
    backfillStart || home?.since?.slice(0, 10) || "";

  return (
    <div className="space-y-6">
      {/* Home location */}
      <SettingsCard>
        <SettingsCardHeader
          icon={MapPin}
          title={t("settings.sections.environment.home.title")}
        />
        <p className="text-sm leading-relaxed">
          {t("settings.sections.environment.home.description")}
        </p>
        <div className="space-y-3">
          {home ? (
            <div className="space-y-1">
              <p className="text-sm" data-slot="environment-home-current">
                {t("settings.sections.environment.home.current", {
                  label: home.label ?? `${home.lat}, ${home.lon}`,
                })}
              </p>
              {home.since && (
                <p className="text-muted-foreground text-xs">
                  {t("settings.sections.environment.home.since", {
                    date: fmt.dateShortSmartCalendar(home.since.slice(0, 10)),
                  })}
                </p>
              )}
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">
              {t("settings.sections.environment.home.none")}
            </p>
          )}
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (homeQuery.trim().length > 0 && !searchHome.isPending) {
                searchHome.mutate();
              }
            }}
          >
            <Input
              value={homeQuery}
              onChange={(e) => {
                setHomeQuery(e.target.value);
                setHomeSearched(false);
              }}
              placeholder={t("settings.sections.environment.searchPlaceholder")}
              aria-label={t("settings.sections.environment.searchPlaceholder")}
            />
            <Button
              type="submit"
              variant="outline"
              size="sm"
              className="min-h-11 sm:min-h-9"
              disabled={homeQuery.trim().length === 0 || searchHome.isPending}
            >
              {t("settings.sections.environment.search")}
            </Button>
          </form>
          {homeSearched &&
            !searchHome.isPending &&
            homeResults.length === 0 && (
              <p className="text-muted-foreground text-sm">
                {t("settings.sections.environment.noResults")}
              </p>
            )}
          {homeResults.length > 0 && (
            <ul className="divide-border divide-y rounded-md border">
              {homeResults.map((r) => (
                <li
                  key={`${r.lat},${r.lon},${r.label}`}
                  className="flex items-center justify-between gap-2 p-2"
                >
                  <span className="text-sm">{r.label}</span>
                  <Button
                    type="button"
                    size="sm"
                    className="min-h-11 sm:min-h-9"
                    disabled={setHome.isPending}
                    onClick={() => setHome.mutate(r)}
                  >
                    {t("settings.sections.environment.use")}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </SettingsCard>

      {/* Travel overrides */}
      <SettingsCard>
        <SettingsCardHeader
          icon={Plane}
          title={t("settings.sections.environment.travel.title")}
        />
        <p className="text-sm leading-relaxed">
          {t("settings.sections.environment.travel.description")}
        </p>
        <div className="space-y-3">
          {data && data.travel.length > 0 ? (
            <ul className="divide-border divide-y rounded-md border">
              {data.travel.map((tr) => (
                <li
                  key={tr.id}
                  className="flex items-center justify-between gap-2 p-2"
                >
                  <span className="text-sm">
                    {tr.label} · {fmt.dateShortSmartCalendar(tr.startDate)} –{" "}
                    {fmt.dateShortSmartCalendar(tr.endDate)}
                  </span>
                  <ConfirmButton
                    slot="travel-remove"
                    size="icon"
                    variant="ghost"
                    className="min-h-11 min-w-11 sm:min-h-9 sm:min-w-9"
                    ariaLabel={t("settings.sections.environment.travel.remove")}
                    label=""
                    icon={<Trash2 className="size-4" aria-hidden />}
                    pending={removeTravel.isPending}
                    title={t(
                      "settings.sections.environment.travel.removeConfirmTitle",
                    )}
                    body={t(
                      "settings.sections.environment.travel.removeConfirmBody",
                    )}
                    confirmLabel={t(
                      "settings.sections.environment.travel.remove",
                    )}
                    onConfirm={() => removeTravel.mutate(tr.id)}
                  />
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground text-sm">
              {t("settings.sections.environment.travel.none")}
            </p>
          )}

          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (travelQuery.trim().length > 0 && !searchTravel.isPending) {
                searchTravel.mutate();
              }
            }}
          >
            <Input
              value={travelQuery}
              onChange={(e) => {
                setTravelQuery(e.target.value);
                setTravelSearched(false);
              }}
              placeholder={t("settings.sections.environment.searchPlaceholder")}
              aria-label={t("settings.sections.environment.searchPlaceholder")}
            />
            <Button
              type="submit"
              variant="outline"
              size="sm"
              className="min-h-11 sm:min-h-9"
              disabled={
                travelQuery.trim().length === 0 || searchTravel.isPending
              }
            >
              {t("settings.sections.environment.search")}
            </Button>
          </form>
          {travelSearched &&
            !searchTravel.isPending &&
            travelResults.length === 0 && (
              <p className="text-muted-foreground text-sm">
                {t("settings.sections.environment.noResults")}
              </p>
            )}
          {travelResults.length > 0 && (
            <ul className="divide-border divide-y rounded-md border">
              {travelResults.map((r) => (
                <li
                  key={`${r.lat},${r.lon},${r.label}`}
                  className="flex items-center justify-between gap-2 p-2"
                >
                  <span className="text-sm">{r.label}</span>
                  <Button
                    type="button"
                    size="sm"
                    className="min-h-11 sm:min-h-9"
                    variant={
                      travelLoc?.label === r.label ? "default" : "secondary"
                    }
                    onClick={() => setTravelLoc(r)}
                  >
                    {t("settings.sections.environment.select")}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {travelLoc && (
            <div className="flex flex-wrap items-end gap-2">
              <div className="space-y-1">
                <Label htmlFor="env-travel-start">
                  {t("settings.sections.environment.startDate")}
                </Label>
                <DateField
                  id="env-travel-start"
                  value={travelStart}
                  onChange={setTravelStart}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="env-travel-end">
                  {t("settings.sections.environment.endDate")}
                </Label>
                <DateField
                  id="env-travel-end"
                  value={travelEnd}
                  onChange={setTravelEnd}
                />
              </div>
              <Button
                type="button"
                size="sm"
                className="min-h-11 sm:min-h-9"
                disabled={travelStart > travelEnd || addTravel.isPending}
                onClick={() => addTravel.mutate()}
              >
                {t("settings.sections.environment.travel.add", {
                  label: travelLoc.label,
                })}
              </Button>
            </div>
          )}
        </div>
      </SettingsCard>

      {/* Backfill */}
      <SettingsCard>
        <SettingsCardHeader
          icon={CloudSun}
          title={t("settings.sections.environment.backfill.title")}
        />
        <p className="text-sm leading-relaxed">
          {t("settings.sections.environment.backfill.description")}
        </p>
        <div className="flex flex-wrap items-end gap-4">
          <div className="space-y-1">
            <Label htmlFor="env-backfill-start">
              {t("settings.sections.environment.startDate")}
            </Label>
            <DateField
              id="env-backfill-start"
              value={effectiveBackfillStart}
              onChange={setBackfillStart}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="env-backfill-end">
              {t("settings.sections.environment.endDate")}
            </Label>
            <DateField
              id="env-backfill-end"
              value={backfillEnd}
              onChange={setBackfillEnd}
            />
          </div>
        </div>
        {data && (
          <p className="text-muted-foreground text-xs">
            {t("settings.sections.environment.storedDays", {
              count: data.context.days,
            })}
          </p>
        )}
        {data?.lastFetchFailure && (
          <p
            role="status"
            data-testid="environment-fetch-failed"
            className="text-destructive text-xs"
          >
            {tCount(
              "settings.sections.environment.fetchFailed",
              data.lastFetchFailure.failures,
              {
                count: data.lastFetchFailure.failures,
                when: formatDateTime(data.lastFetchFailure.lastFailedAt),
              },
            )}
          </p>
        )}
        {/* The action row closes the card; the status lines sit above it. */}
        <SettingsCardActions>
          <Button
            type="button"
            size="sm"
            className="min-h-11 sm:min-h-9"
            disabled={
              !home ||
              effectiveBackfillStart.length === 0 ||
              effectiveBackfillStart > backfillEnd ||
              backfill.isPending
            }
            onClick={() => backfill.mutate(effectiveBackfillStart)}
          >
            {t("settings.sections.environment.backfill.run")}
          </Button>
        </SettingsCardActions>
      </SettingsCard>

      {/* Air quality, pollen and UV (v1.42) */}
      {data && (
        <SettingsCard data-testid="environment-air-quality">
          <SettingsCardHeader
            icon={Wind}
            title={t("settings.sections.environment.airQuality.title")}
            status={
              <label className="flex min-h-11 items-center gap-3">
                <Switch
                  checked={
                    data.airQuality.enabled && !data.airQuality.operatorDisabled
                  }
                  onCheckedChange={(next) => setAirQuality.mutate(next)}
                  disabled={
                    data.airQuality.operatorDisabled || setAirQuality.isPending
                  }
                  aria-label={t(
                    "settings.sections.environment.airQuality.toggle",
                  )}
                />
              </label>
            }
          />
          <p className="text-sm leading-relaxed">
            {t("settings.sections.environment.airQuality.description")}
          </p>
          {data.airQuality.operatorDisabled ? (
            <p className="text-muted-foreground text-sm">
              {t("settings.sections.environment.airQuality.operatorDisabled")}
            </p>
          ) : data.airQuality.enabled ? (
            <div className="space-y-3">
              <p className="text-muted-foreground text-xs">
                {t("settings.sections.environment.airQuality.coverage", {
                  count: data.airQuality.days,
                })}
                {data.airQuality.domain === "cams_global"
                  ? ` ${t("settings.sections.environment.airQuality.pollenEuropeOnly")}`
                  : ""}
              </p>
              {data.airQuality.history && data.airQuality.history.total > 0 && (
                <p
                  className="text-muted-foreground text-xs"
                  data-testid="environment-aq-history"
                  data-complete={data.airQuality.history.complete}
                >
                  {data.airQuality.history.complete
                    ? t(
                        "settings.sections.environment.airQuality.historyComplete",
                        { total: data.airQuality.history.total },
                      )
                    : t(
                        "settings.sections.environment.airQuality.historyProgress",
                        {
                          done: data.airQuality.history.done,
                          total: data.airQuality.history.total,
                        },
                      )}
                </p>
              )}
              {data.latestDay?.airQuality && (
                <div className="space-y-2">
                  <p className="text-sm font-medium">
                    {t("settings.sections.environment.airQuality.latest", {
                      date: fmt.dateShortSmartCalendar(data.latestDay.date),
                    })}
                  </p>
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                    {(
                      [
                        [
                          "environment.fields.pm25",
                          envValue(data.latestDay.airQuality.pm25Mean, "µg/m³"),
                        ],
                        [
                          "environment.fields.pm10",
                          envValue(data.latestDay.airQuality.pm10Mean, "µg/m³"),
                        ],
                        [
                          "environment.fields.no2",
                          envValue(data.latestDay.airQuality.no2Mean, "µg/m³"),
                        ],
                        [
                          "environment.fields.ozone8h",
                          envValue(data.latestDay.airQuality.o3Max8h, "µg/m³"),
                        ],
                        [
                          "environment.fields.europeanAqi",
                          envValue(data.latestDay.airQuality.eaqiMax, ""),
                        ],
                        [
                          "environment.fields.uvIndexMax",
                          envValue(data.latestDay.airQuality.uvIndexMax, "", 1),
                        ],
                        [
                          "environment.fields.dustMax",
                          envValue(data.latestDay.airQuality.dustMax, "µg/m³"),
                        ],
                        [
                          "environment.fields.pollenMax",
                          envValue(
                            pollenMax(data.latestDay.airQuality.pollen),
                            "/m³",
                          ),
                        ],
                      ] as const
                    ).map(([labelKey, value]) => (
                      <div key={labelKey} className="contents">
                        <dt className="text-muted-foreground text-xs">
                          {t(labelKey)}
                        </dt>
                        <dd className="tabular-nums">{value}</dd>
                      </div>
                    ))}
                  </dl>
                  <p className="text-muted-foreground text-xs">
                    {t("settings.sections.environment.airQuality.modelNote")}
                  </p>
                </div>
              )}
            </div>
          ) : null}
        </SettingsCard>
      )}

      {/* Attribution (CC BY 4.0 for Open-Meteo; Copernicus notice for the
          air-quality values), one line per source. */}
      <ul
        className="text-muted-foreground space-y-0.5 text-xs"
        aria-label={t("settings.sections.environment.airQuality.attribution")}
      >
        {(
          data?.attributions ?? [
            data?.attribution ?? "Weather data by Open-Meteo.com",
          ]
        ).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  );
}
