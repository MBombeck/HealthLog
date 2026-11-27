/**
 * The words an integration card says about a connection's health.
 *
 * The server resolves one `ConnectionHealth` per connection and the card only
 * renders it, so everything here is a projection: a status tone per state, one
 * sentence per reason, a relative instant, and the plain-text diagnostics a
 * person can paste into a bug report. Nothing in this module decides a state.
 *
 * Pure (a translator and the locale formatters are passed in) so every
 * sentence and the copied diagnostics are unit-testable without a renderer.
 */
import type {
  ConnectionHealth,
  ConnectionHealthState,
  UnavailableItem,
} from "@/lib/integrations/connection-health";
import { pluralKey } from "@/lib/i18n/plural";
import { previousDayLabel } from "@/lib/tz/format";
import type { Locale } from "@/lib/i18n/config";
import type { StatusChipTone } from "@/components/ui/status-chip";

type Translate = (
  key: string,
  params?: Record<string, string | number>,
) => string;

interface InstantFormatters {
  dateShortSmart: (value: Date) => string;
  time: (value: Date) => string;
}

/** The status chip's tone: a limited connection still works, a degraded one does not. */
export function healthStatusTone(state: ConnectionHealthState): StatusChipTone {
  return state === "ok" || state === "limited" ? "active" : "error";
}

/**
 * An instant as a person reads it: "today, 07:12", "yesterday, 18:40", or the
 * date with its time. The day comparison goes through the same zone-aware
 * formatter that prints the date, so the boundary and the printed day can
 * never disagree.
 */
export function formatHealthInstant(
  iso: string,
  t: Translate,
  fmt: InstantFormatters,
  now: Date = new Date(),
): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const day = fmt.dateShortSmart(at);
  const time = fmt.time(at);
  if (day === fmt.dateShortSmart(now)) {
    return t("settings.integrationCard.when.today", { time });
  }
  if (day === previousDayLabel(now, fmt.dateShortSmart)) {
    return t("settings.integrationCard.when.yesterday", { time });
  }
  return t("settings.integrationCard.when.date", { date: day, time });
}

/**
 * A readable name for a data type the provider withholds. Written as literal
 * keys so the i18n coverage guards see each one; an unknown key degrades to a
 * readable form of itself rather than leaking `snake_case`.
 */
export function unavailableItemLabel(item: string, t: Translate): string {
  switch (item) {
    case "spo2":
      return t("settings.integrations.withings.plan.items.spo2");
    case "vascularAge":
      return t("settings.integrations.withings.plan.items.vascularAge");
    case "pulseWaveVelocity":
      return t("settings.integrations.withings.plan.items.pulseWaveVelocity");
    case "vo2Max":
      return t("settings.integrations.withings.plan.items.vo2Max");
    case "visceralFat":
      return t("settings.integrations.withings.plan.items.visceralFat");
    case "skinTemperature":
      return t("settings.integrations.withings.plan.items.skinTemperature");
    case "ecg":
      return t("settings.integrations.withings.plan.items.ecg");
    case "sleepScore":
      return t("settings.integrations.withings.plan.items.sleepScore");
    case "sleepHrv":
      return t("settings.integrations.withings.plan.items.sleepHrv");
    case "sleepHeartRate":
      return t("settings.integrations.withings.plan.items.sleepHeartRate");
    case "sleepRespiratoryRate":
      return t(
        "settings.integrations.withings.plan.items.sleepRespiratoryRate",
      );
    case "sleepSpo2":
      return t("settings.integrations.withings.plan.items.sleepSpo2");
    case "bodyTemperature":
      return t("settings.integrations.withings.plan.items.bodyTemperature");
    case "bodyFat":
      return t("settings.integrations.withings.plan.items.bodyFat");
    case "fatMass":
      return t("settings.integrations.withings.plan.items.fatMass");
    case "fatFreeMass":
      return t("settings.integrations.withings.plan.items.fatFreeMass");
    case "muscleMass":
      return t("settings.integrations.withings.plan.items.muscleMass");
    case "bodyWater":
      return t("settings.integrations.withings.plan.items.bodyWater");
    case "boneMass":
      return t("settings.integrations.withings.plan.items.boneMass");
    case "heartRate":
      return t("settings.integrations.withings.plan.items.heartRate");
    case "bloodPressure":
      return t("settings.integrations.withings.plan.items.bloodPressure");
    case "weight":
      return t("settings.integrations.withings.plan.items.weight");
    case "vo2max":
      return t("settings.integrations.oura.scope.items.vo2max");
    case "cardio_age":
      return t("settings.integrations.oura.scope.items.cardio_age");
    case "resilience":
      return t("settings.integrations.oura.scope.items.resilience");
    case "workout":
      return t("settings.integrations.oura.scope.items.workout");
    case "heartrate":
      return t("settings.integrations.oura.scope.items.heartrate");
    case "activity":
      return t("settings.integrationCard.items.activity");
    case "sleep":
      return t("settings.integrationCard.items.sleep");
    default: {
      const words = item
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/[_-]+/g, " ")
        .toLowerCase();
      return words;
    }
  }
}

/**
 * At most three names in a sentence. Up to three types are all named; more
 * than three name the first two and count the rest ("SpO2, vascular age and
 * 3 more"), and the full list lives in the details.
 */
export function namedItemList(
  items: readonly UnavailableItem[],
  t: Translate,
  locale: Locale,
): string {
  const labels = items.map((u) => unavailableItemLabel(u.item, t));
  const parts =
    labels.length <= 3
      ? labels
      : [
          ...labels.slice(0, 2),
          t(
            pluralKey(
              "settings.integrationCard.moreValues",
              labels.length - 2,
              locale,
            ),
            { count: labels.length - 2 },
          ),
        ];
  try {
    return new Intl.ListFormat(locale, {
      style: "long",
      type: "conjunction",
    }).format(parts);
  } catch {
    return parts.join(", ");
  }
}

export interface HealthSentenceOptions {
  /** Provider name as the person knows it ("Oura", "Withings"). */
  provider: string;
  /** Older history is still loading (a server fact, e.g. backfill pending). */
  historyLoading?: boolean;
  /** Apple Health: data only moves when the iPhone app runs. */
  appleHealth?: boolean;
  locale: Locale;
  fmt: InstantFormatters;
  now?: Date;
}

/** The one sentence a card says under its header. */
export function healthSentence(
  health: ConnectionHealth,
  t: Translate,
  options: HealthSentenceOptions,
): string {
  const { provider, locale, fmt } = options;
  const since = health.since
    ? formatHealthInstant(health.since, t, fmt, options.now)
    : null;
  const ofCause = (cause: UnavailableItem["cause"]) =>
    namedItemList(
      health.unavailable.filter((u) => u.cause === cause),
      t,
      locale,
    );

  switch (health.reason) {
    case "data_arriving":
      return options.historyLoading
        ? t("settings.integrationCard.reason.dataArrivingHistory")
        : t("settings.integrationCard.reason.dataArriving");
    case "first_sync_pending":
      return t("settings.integrationCard.reason.firstSyncPending");
    case "plan_limited":
      return t("settings.integrationCard.reason.planLimited", {
        provider,
        list: ofCause("plan"),
      });
    case "permission_limited":
      return t("settings.integrationCard.reason.permissionLimited", {
        list: ofCause("permission"),
      });
    case "provider_errors":
      return since
        ? t("settings.integrationCard.reason.providerErrors", {
            provider,
            since,
          })
        : t("settings.integrationCard.reason.providerErrorsNoSince", {
            provider,
          });
    case "sync_stalled":
      return since
        ? t("settings.integrationCard.reason.syncStalled", { since })
        : t("settings.integrationCard.reason.syncStalledNoSince");
    case "no_new_data":
      if (options.appleHealth) {
        return since
          ? t("settings.integrationCard.reason.noNewDataApple", { since })
          : t("settings.integrationCard.reason.noNewDataAppleNoSince");
      }
      return since
        ? t("settings.integrationCard.reason.noNewData", { since })
        : t("settings.integrationCard.reason.noNewDataNoSince");
    case "unexpected_silence":
      return since
        ? t("settings.integrationCard.reason.unexpectedSilence", {
            provider,
            since,
          })
        : t("settings.integrationCard.reason.unexpectedSilenceNoSince", {
            provider,
          });
    case "reauth_required":
      return t("settings.integrationCard.reason.reauthRequired", { provider });
    case "paused_after_errors":
      return since
        ? t("settings.integrationCard.reason.pausedAfterErrors", {
            provider,
            since,
          })
        : t("settings.integrationCard.reason.pausedAfterErrorsNoSince", {
            provider,
          });
  }
}

/** `2026-10-14T18:40:12.000Z` → `2026-10-14 18:40 UTC`. */
function utc(iso: string | null): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export interface DiagnosticsInput {
  /** The running app version; empty when the build did not stamp one. */
  version: string;
  provider: string;
  health: ConnectionHealth;
  /** Extra lines the card adds, already redacted (a failure streak count). */
  extra?: readonly string[];
}

/**
 * The plain-text diagnostics, exactly as the details block shows them and the
 * copy button places them on the clipboard.
 *
 * Built only from `health`, whose diagnostics the server already reduced to
 * leg names, outcomes, instants and short error codes. No measured value, no
 * token, no account id and no provider error message can reach this text,
 * because none of them is on the input.
 */
export function diagnosticsText(input: DiagnosticsInput, t: Translate): string {
  const { health } = input;
  const none = t("settings.integrationCard.details.none");
  const lines: string[] = [];
  lines.push(
    `${["HealthLog", input.version].filter(Boolean).join(" ")}  ${input.provider}`,
  );
  const since = utc(health.since);
  lines.push(
    `${t("settings.integrationCard.details.state")}: ${health.state} / ${health.reason}${
      since ? ` ${t("settings.integrationCard.details.since")} ${since}` : ""
    }`,
  );
  lines.push(
    `${t("settings.integrationCard.details.lastSync")}: ${utc(health.lastSuccessAt) ?? none}`,
  );
  lines.push(
    `${t("settings.integrationCard.details.lastData")}: ${utc(health.lastDataAt) ?? none}`,
  );
  const d = health.diagnostics;
  if (d.ledgerState || d.failingLegs.length > 0) {
    const legs =
      d.failingLegs.length > 0
        ? `, ${t("settings.integrationCard.details.failingParts")}: ${d.failingLegs.join(", ")}`
        : "";
    lines.push(`Ledger: ${d.ledgerState ?? none}${legs}`);
  }
  for (const line of input.extra ?? []) lines.push(line);
  if (d.recentCalls.length > 0) {
    lines.push(`${t("settings.integrationCard.details.recentCalls")}:`);
    const width = Math.max(...d.recentCalls.map((c) => c.endpoint.length));
    for (const call of d.recentCalls) {
      const at = (utc(call.at) ?? "").replace(" UTC", "");
      const row = [
        at,
        call.endpoint.padEnd(width),
        call.status.padEnd(15),
        call.errorCode ?? "",
      ]
        .join("  ")
        .trimEnd();
      lines.push(`  ${row}`);
    }
  }
  if (health.unavailable.length > 0) {
    const items = health.unavailable
      .map(
        (u) =>
          `${u.item} (${
            u.cause === "plan"
              ? t("settings.integrationCard.details.causePlan")
              : t("settings.integrationCard.details.causePermission")
          })`,
      )
      .join(", ");
    lines.push(
      `${t("settings.integrationCard.details.unavailable")}: ${items}`,
    );
  }
  return lines.join("\n");
}
