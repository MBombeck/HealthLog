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
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { PasswordInput } from "@/components/ui/password-input";
import { TagChip } from "@/components/ui/tag-chip";
import { apiFetchRaw, apiPost } from "@/lib/api/api-fetch";
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

/** Where Garmin Connect creates and revokes Personal API keys. */
export const GARMIN_KEY_SETTINGS_URL =
  "https://connect.garmin.com/app/settings/personalApiToken";

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

  const menu: IntegrationMenuAction[] = [
    {
      id: "sync",
      label: t("settings.garminSync"),
      icon: RefreshCw,
      disabled: sync.syncing,
      onSelect: () => sync.run(false),
    },
    {
      id: "test",
      label: t("settings.testConnection.test"),
      icon: Plug,
      disabled: test.testing,
      onSelect: test.run,
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
      onSelect: () => setEditing((open) => !open),
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
      onSelect: () => disconnect.mutate(),
      confirm: {
        title: t("settings.garminDisconnectTitle"),
        body: t("settings.garminDisconnectDescription"),
        confirmLabel: t("settings.garminDisconnect"),
      },
    },
  ];

  const streak = failureStreakFor(status);

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
      diagnosticsExtra={
        streak
          ? [
              t("settings.integrationCard.details.failureStreak", {
                count: streak.count,
                threshold: streak.threshold,
              }),
            ]
          : undefined
      }
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
        let text = t("settings.garminConnectFailed");
        try {
          const json = await res.json();
          if (json.error) text = json.error;
        } catch {
          // keep the generic message
        }
        setMsg({ kind: "error", text });
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
        <Label htmlFor="garmin-key-validity">
          {t("settings.garminKeyValidity")}
        </Label>
        <NativeSelect
          id="garmin-key-validity"
          value={validity}
          onChange={(e) => setValidity(e.target.value)}
        >
          <option value="">{t("settings.garminKeyValidityUnknown")}</option>
          {GARMIN_KEY_VALIDITY_DAYS.map((days) => (
            <option key={days} value={String(days)}>
              {t("settings.garminKeyValidityDays", { count: days })}
            </option>
          ))}
        </NativeSelect>
        <p className="text-muted-foreground text-xs">
          {t("settings.garminKeyValidityHelp")}
        </p>
      </div>
      {msg && (
        <p
          role={msg.kind === "error" ? "alert" : "status"}
          className={`text-sm ${msg.kind === "success" ? "text-success" : "text-destructive"}`}
        >
          {msg.text}
        </p>
      )}
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
