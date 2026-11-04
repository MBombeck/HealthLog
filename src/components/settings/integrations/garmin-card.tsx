"use client";

// Garmin, through the Personal API (#1333). Like Nightscout this is a
// credential the person pastes once rather than an OAuth round-trip: they
// create a key in Garmin Connect and HealthLog buys short-lived tokens with
// it on every sync. The card reads the consolidated `/api/integrations/status`
// envelope like every sibling and renders the shared integration card. The
// one Garmin-specific fact it adds is the key's end: Garmin keys expire after
// the validity picked at creation, and the card says so ahead of time.

import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  BookOpen,
  CalendarClock,
  ExternalLink,
  KeyRound,
  Link2,
  Loader2,
  Plug,
  RefreshCw,
  Save,
  Unlink,
  Watch,
} from "lucide-react";

import { SettingsCardActions } from "@/components/settings/_card-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { PasswordInput } from "@/components/ui/password-input";
import { TagChip } from "@/components/ui/tag-chip";
import { apiFetchRaw, apiPost } from "@/lib/api/api-fetch";
import type { GarminBackfillStep } from "@/lib/garmin/backfill-progress";
import {
  GARMIN_KEY_VALIDITY_DAYS,
  type GarminKeyExpiry,
} from "@/lib/garmin/key-expiry";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import {
  invalidateKeys,
  measurementDependentKeys,
  queryKeys,
} from "@/lib/query-keys";

import {
  ActionResultLines,
  useConnectionTest,
  useStandardSync,
} from "./integration-actions";
import {
  IntegrationCard,
  type IntegrationMenuAction,
} from "./integration-card";
import { MetricFreshnessList } from "./metric-freshness-list";
import {
  IntegrationCardDescription,
  integrationDocsHref,
} from "./setup-guide-link";
import { failureStreakFor, type IntegrationStatusViewModel } from "./shared";

/** The name of each Garmin resource, for the unavailable note. */
const GARMIN_RESOURCE_KEYS: Record<GarminBackfillStep, string> = {
  daily: "settings.garminResource.daily",
  activities: "settings.garminResource.activities",
  sleep: "settings.garminResource.sleep",
  hrv: "settings.garminResource.hrv",
  weight: "settings.garminResource.weight",
  cycle: "settings.garminResource.cycle",
};

/** Where Garmin Connect creates and revokes Personal API keys. */
export const GARMIN_KEY_SETTINGS_URL =
  "https://connect.garmin.com/app/settings/personalApiToken";

/** The connected card's menu, in the order every sibling uses. */
function garminMenu(
  t: ReturnType<typeof useTranslations>["t"],
  h: {
    syncing: boolean;
    testing: boolean;
    onSync: () => void;
    onTest: () => void;
    onToggleKey: () => void;
    onToggleValidity: () => void;
    onDisconnect: () => void;
  },
): IntegrationMenuAction[] {
  return [
    {
      id: "sync",
      label: t("settings.garminSync"),
      icon: RefreshCw,
      disabled: h.syncing,
      onSelect: h.onSync,
    },
    {
      id: "test",
      label: t("settings.testConnection.test"),
      icon: Plug,
      disabled: h.testing,
      onSelect: h.onTest,
    },
    {
      id: "view-data",
      label: t("settings.garminViewData"),
      icon: ArrowRight,
      href: "/insights/recovery",
    },
    {
      id: "credentials",
      label: t("settings.garminReplaceKey"),
      icon: KeyRound,
      onSelect: h.onToggleKey,
    },
    {
      id: "validity",
      label: t("settings.garminKeyValidityMenu"),
      icon: CalendarClock,
      onSelect: h.onToggleValidity,
    },
    {
      id: "setup-guide",
      label: t("settings.integrationSetupGuide"),
      icon: BookOpen,
      href: integrationDocsHref("garmin"),
      external: true,
    },
    {
      id: "disconnect",
      label: t("settings.garminDisconnect"),
      icon: Unlink,
      destructive: true,
      onSelect: h.onDisconnect,
      confirm: {
        title: t("settings.garminDisconnectTitle"),
        body: t("settings.garminDisconnectDescription"),
        confirmLabel: t("settings.garminDisconnect"),
      },
    },
  ];
}

export function GarminCard({
  viewModel,
}: {
  viewModel?: IntegrationStatusViewModel;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const queryClient = useQueryClient();
  const status = viewModel;
  const connected = status?.connected ?? false;

  const sync = useStandardSync({
    provider: "garmin",
    i18nPrefix: "settings.garmin",
    acceptsFullSync: false,
  });
  const test = useConnectionTest("/api/garmin/test");
  const [editing, setEditing] = useState(false);
  const [validityEditing, setValidityEditing] = useState(false);
  const formRef = useRef<HTMLFormElement | null>(null);

  const disconnect = useMutation({
    mutationFn: async () => {
      await apiPost("/api/garmin/disconnect");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.integrationsStatus(),
      });
    },
  });

  // An expired or revoked key is resolved by pasting a new one: the button
  // opens the form and puts the cursor in the key field.
  function openForm() {
    setEditing(true);
    requestAnimationFrame(() => {
      formRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      formRef.current
        ?.querySelector<HTMLInputElement>("#garmin-api-key")
        ?.focus();
    });
  }

  const form = <GarminForm formRef={formRef} connected={connected} />;

  if (!connected) {
    return (
      <IntegrationCard
        provider="garmin"
        providerName={t("settings.garmin")}
        icon={Watch}
        titleAccessory={<TagChip>{t("settings.garminTag")}</TagChip>}
        description={
          <IntegrationCardDescription
            i18nPrefix="settings.garmin"
            provider="garmin"
          />
        }
        loading={viewModel === undefined}
        connected={false}
        health={null}
        setup={form}
      />
    );
  }

  const keyExpiry = status?.keyExpiry ?? null;
  const expiryNote = garminKeyExpiryNote(keyExpiry, t, fmt.date);

  const menu = garminMenu(t, {
    syncing: sync.syncing,
    testing: test.testing,
    onSync: () => sync.run(false),
    onTest: test.run,
    onToggleKey: () => setEditing((open) => !open),
    onToggleValidity: () => setValidityEditing((open) => !open),
    onDisconnect: () => disconnect.mutate(),
  });

  const streak = failureStreakFor(status);
  // Resources Garmin refuses for this account (a cycle summary for someone
  // who tracks none): listed in the details, never a failure of the card.
  const unavailable = status?.unavailableResources ?? [];
  const unavailableNote =
    unavailable.length > 0
      ? t("settings.garminUnavailable", {
          list: unavailable.map((r) => t(GARMIN_RESOURCE_KEYS[r])).join(", "),
        })
      : null;

  return (
    <IntegrationCard
      provider="garmin"
      providerName={t("settings.garmin")}
      icon={Watch}
      titleAccessory={<TagChip>{t("settings.garminTag")}</TagChip>}
      connected
      health={status?.health ?? null}
      historyLoading={status?.backfillCompleted === false}
      primary={{ onReconnect: openForm, onResume: openForm }}
      menu={menu}
      diagnosticsExtra={[
        ...(streak
          ? [
              t("settings.integrationCard.details.failureStreak", {
                count: streak.count,
                threshold: streak.threshold,
              }),
            ]
          : []),
        ...(unavailableNote ? [unavailableNote] : []),
      ]}
      details={
        <>
          {keyExpiry?.state === "ok" && keyExpiry.expiresAt ? (
            <p
              className="text-muted-foreground text-xs"
              data-testid="garmin-key-valid-until"
            >
              {t("settings.garminKeyValidUntil", {
                date: fmt.date(keyExpiry.expiresAt),
              })}
            </p>
          ) : null}
          {unavailableNote ? (
            <p
              className="text-muted-foreground text-xs"
              data-testid="garmin-unavailable"
            >
              {unavailableNote}
            </p>
          ) : null}
          {status?.metricFreshness?.length ? (
            <MetricFreshnessList entries={status.metricFreshness} />
          ) : null}
        </>
      }
    >
      {expiryNote ? (
        // The one fact the generic sentence cannot carry: the key has an end
        // date the person chose, and only a new key moves it. Said in the
        // body, not as a banner, like Nightscout's operator note.
        <p
          className="text-sm"
          data-testid="garmin-key-expiry"
          data-state={keyExpiry?.state}
        >
          {expiryNote}
        </p>
      ) : null}
      <ActionResultLines provider="garmin" sync={sync} test={test} />
      {editing ? form : null}
      {validityEditing ? <GarminValidityForm /> : null}
    </IntegrationCard>
  );
}

/**
 * The body sentence for a key that has expired, is about to, or whose end is
 * unknown; null while it is comfortably valid.
 */
export function garminKeyExpiryNote(
  keyExpiry: GarminKeyExpiry | null | undefined,
  t: ReturnType<typeof useTranslations>["t"],
  formatDate: (iso: string) => string,
): string | null {
  if (!keyExpiry) return null;
  const { expiresAt, daysLeft } = keyExpiry;
  switch (keyExpiry.state) {
    case "expired":
      return t("settings.garminKeyExpired", {
        date: expiresAt ? formatDate(expiresAt) : "",
      });
    case "expiring":
      return daysLeft === 0
        ? t("settings.garminKeyExpiresToday")
        : t("settings.garminKeyExpiring", {
            date: expiresAt ? formatDate(expiresAt) : "",
          });
    case "unknown":
      return t("settings.garminKeyExpiryUnknown");
    default:
      return null;
  }
}

/** Error codes the Garmin routes answer, with the sentence each one gets. */
const GARMIN_ERROR_KEYS: Record<string, string> = {
  "garmin.key_refused": "settings.garminErrors.keyRefused",
  "garmin.rate_limited": "settings.garminErrors.rateLimited",
  "garmin.unreachable": "settings.garminErrors.unreachable",
};

/** The sentence for a refused request, from its `meta.errorCode`. */
async function garminErrorKey(res: Response): Promise<string> {
  try {
    const json = (await res.json()) as { meta?: { errorCode?: unknown } };
    const code = json?.meta?.errorCode;
    if (typeof code === "string" && GARMIN_ERROR_KEYS[code]) {
      return GARMIN_ERROR_KEYS[code];
    }
  } catch {
    // keep the generic sentence
  }
  return res.status === 422
    ? "settings.garminErrors.invalid"
    : "settings.garminErrors.generic";
}

function ValiditySelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslations();
  return (
    <NativeSelect
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{t("settings.garminKeyValidityUnknown")}</option>
      {GARMIN_KEY_VALIDITY_DAYS.map((days) => (
        <option key={days} value={String(days)}>
          {t("settings.garminKeyValidityDays", { count: days })}
        </option>
      ))}
    </NativeSelect>
  );
}

function FormMessage({
  msg,
}: {
  msg: { kind: "success" | "error"; text: string } | null;
}) {
  if (!msg) return null;
  return (
    <p
      role={msg.kind === "error" ? "alert" : "status"}
      className={`text-sm ${msg.kind === "success" ? "text-success" : "text-destructive"}`}
    >
      {msg.text}
    </p>
  );
}

function GarminForm({
  formRef,
  connected,
}: {
  formRef: React.RefObject<HTMLFormElement | null>;
  connected: boolean;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [apiKey, setApiKey] = useState("");
  const [region, setRegion] = useState<"global" | "china">("global");
  const [validity, setValidity] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{
    kind: "success" | "error";
    text: string;
  } | null>(null);

  async function handleConnect(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMsg(null);
    try {
      const res = await apiFetchRaw("/api/garmin/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiKey: apiKey.trim(),
          region,
          validityDays: validity ? Number(validity) : null,
        }),
      });
      if (res.ok) {
        setMsg({ kind: "success", text: t("settings.garminConnected") });
        setApiKey("");
        void invalidateKeys(queryClient, measurementDependentKeys);
        queryClient.invalidateQueries({
          queryKey: queryKeys.integrationsStatus(),
        });
      } else {
        setMsg({ kind: "error", text: t(await garminErrorKey(res)) });
      }
    } catch {
      setMsg({ kind: "error", text: t("common.networkError") });
    }
    setSaving(false);
  }

  return (
    <form
      ref={formRef}
      onSubmit={handleConnect}
      className="space-y-3"
      data-testid="garmin-form"
    >
      <p className="text-muted-foreground text-xs">
        {t("settings.garminKeyHowTo")}{" "}
        <a
          href={GARMIN_KEY_SETTINGS_URL}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="garmin-key-settings-link"
          className="hover:text-foreground inline-flex items-center gap-1 underline underline-offset-2"
        >
          {t("settings.garminKeySettingsLink")}
          <ExternalLink className="h-3 w-3" aria-hidden="true" />
        </a>
      </p>
      <div className="space-y-1.5">
        <Label htmlFor="garmin-api-key">{t("settings.garminApiKey")}</Label>
        <PasswordInput
          id="garmin-api-key"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={
            connected
              ? t("settings.garminApiKeySavedPlaceholder")
              : t("settings.garminApiKeyPlaceholder")
          }
          maxLength={1024}
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="none"
          enterKeyHint="next"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="garmin-region">{t("settings.garminRegion")}</Label>
        <NativeSelect
          id="garmin-region"
          value={region}
          onChange={(e) =>
            setRegion(e.target.value === "china" ? "china" : "global")
          }
        >
          <option value="global">{t("settings.garminRegionGlobal")}</option>
          <option value="china">{t("settings.garminRegionChina")}</option>
        </NativeSelect>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="garmin-key-validity">
          {t("settings.garminKeyValidity")}
        </Label>
        <ValiditySelect
          id="garmin-key-validity"
          value={validity}
          onChange={setValidity}
        />
        <p className="text-muted-foreground text-xs">
          {t("settings.garminKeyValidityHelp")}
        </p>
      </div>
      <FormMessage msg={msg} />
      <SettingsCardActions>
        <Button
          type="submit"
          size="sm"
          variant={connected ? "outline" : "default"}
          className="min-h-11 w-full sm:min-h-9 sm:w-auto"
          disabled={saving || !apiKey.trim()}
          data-slot={connected ? undefined : "integration-primary-action"}
          data-action={connected ? undefined : "connect"}
          data-testid="garmin-connect"
        >
          {saving ? (
            <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
          ) : connected ? (
            <Save className="size-3.5" aria-hidden="true" />
          ) : (
            <Link2 className="size-3.5" aria-hidden="true" />
          )}
          {connected ? t("settings.garminUpdate") : t("settings.garminConnect")}
        </Button>
      </SettingsCardActions>
    </form>
  );
}

/**
 * Correct the stored key's validity without pasting the key again: the
 * validity picked in Garmin Connect and the day the key was created there.
 */
function GarminValidityForm() {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [validity, setValidity] = useState("");
  const [createdOn, setCreatedOn] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{
    kind: "success" | "error";
    text: string;
  } | null>(null);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMsg(null);
    try {
      const res = await apiFetchRaw("/api/garmin/key-expiry", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          validityDays: validity ? Number(validity) : null,
          ...(createdOn ? { createdOn } : {}),
        }),
      });
      if (res.ok) {
        setMsg({ kind: "success", text: t("settings.garminValiditySaved") });
        queryClient.invalidateQueries({
          queryKey: queryKeys.integrationsStatus(),
        });
      } else {
        setMsg({ kind: "error", text: t(await garminErrorKey(res)) });
      }
    } catch {
      setMsg({ kind: "error", text: t("common.networkError") });
    }
    setSaving(false);
  }

  return (
    <form
      onSubmit={handleSave}
      className="space-y-3"
      data-testid="garmin-validity-form"
    >
      <div className="space-y-1.5">
        <Label htmlFor="garmin-validity-days">
          {t("settings.garminKeyValidity")}
        </Label>
        <ValiditySelect
          id="garmin-validity-days"
          value={validity}
          onChange={setValidity}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="garmin-key-created-on">
          {t("settings.garminKeyCreatedOn")}
        </Label>
        <Input
          id="garmin-key-created-on"
          type="date"
          value={createdOn}
          onChange={(e) => setCreatedOn(e.target.value)}
        />
        <p className="text-muted-foreground text-xs">
          {t("settings.garminKeyCreatedOnHelp")}
        </p>
      </div>
      <FormMessage msg={msg} />
      <SettingsCardActions>
        <Button
          type="submit"
          size="sm"
          variant="outline"
          className="min-h-11 w-full sm:min-h-9 sm:w-auto"
          disabled={saving}
          data-testid="garmin-validity-save"
        >
          {saving ? (
            <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
          ) : (
            <Save className="size-3.5" aria-hidden="true" />
          )}
          {t("settings.garminUpdate")}
        </Button>
      </SettingsCardActions>
    </form>
  );
}
