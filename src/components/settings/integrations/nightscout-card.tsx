"use client";

// Nightscout CGM. Unlike the OAuth providers, Nightscout is a URL and an
// optional token the self-hoster pastes once: they run their own instance and
// HealthLog pulls continuous glucose from it. The card reads the consolidated
// `/api/integrations/status` envelope like every sibling and renders the
// shared integration card. Private-network access is operator-owned through an
// exact-origin server allowlist; an ordinary user cannot weaken the
// outbound-request policy, and the card says so when that is what stands in
// the way.

import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  BookOpen,
  Droplet,
  KeyRound,
  Link2,
  Loader2,
  Plug,
  RefreshCw,
  Unlink,
} from "lucide-react";

import { SettingsCardActions } from "@/components/settings/_card-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { TagChip } from "@/components/ui/tag-chip";
import { toastWrittenOutcome } from "@/components/outcome/outcome-toast";
import { apiFetchRaw, apiPost } from "@/lib/api/api-fetch";
import { showErrorToast } from "@/lib/errors/error-toast";
import { useTranslations } from "@/lib/i18n/context";
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

export function NightscoutCard({
  viewModel,
}: {
  viewModel?: IntegrationStatusViewModel;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const status = viewModel;
  const connected = status?.connected ?? false;

  const sync = useStandardSync({
    provider: "nightscout",
    i18nPrefix: "settings.nightscout",
    acceptsFullSync: false,
  });
  const test = useConnectionTest("/api/nightscout/test");
  const [editing, setEditing] = useState(false);
  const formRef = useRef<HTMLFormElement | null>(null);

  const disconnect = useMutation({
    mutationFn: async () => {
      await apiPost("/api/nightscout/disconnect");
    },
    onSuccess: () => {
      // The card reads the consolidated envelope, so that is the one key a
      // disconnect has to invalidate for the card to flip back.
      queryClient.invalidateQueries({
        queryKey: queryKeys.integrationsStatus(),
      });
      toastWrittenOutcome(
        "success",
        t("settings.integrationDisconnected", {
          provider: t("settings.nightscout"),
        }),
      );
    },
    // The confirmation has closed by now; a refused disconnect would leave
    // the card connected without a word.
    onError: (failure) =>
      showErrorToast(
        t("settings.integrationDisconnectFailed", {
          provider: t("settings.nightscout"),
        }),
        { cause: failure },
      ),
  });

  // A pause or a lapsed token is resolved by submitting the address again:
  // there is no OAuth round-trip to re-run, so the button opens the form and
  // puts the cursor in the URL field.
  function openForm() {
    setEditing(true);
    requestAnimationFrame(() => {
      formRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      formRef.current
        ?.querySelector<HTMLInputElement>("#nightscout-url")
        ?.focus();
    });
  }

  // The newest recorded attempt names the one failure the person cannot fix
  // from here: the instance sits on a private network the operator has not
  // approved. Read from the health diagnostics' short error code, never from
  // a stored message.
  const operatorApprovalRequired =
    status?.health?.diagnostics.recentCalls[0]?.errorCode ===
    "private_origin_not_approved";

  const form = (
    <NightscoutForm
      formRef={formRef}
      connected={connected}
      configured={status?.configured ?? false}
      hasToken={status?.hasToken ?? false}
    />
  );

  if (!connected) {
    return (
      <IntegrationCard
        provider="nightscout"
        providerName={t("settings.nightscout")}
        icon={Droplet}
        titleAccessory={<TagChip>{t("settings.nightscoutTag")}</TagChip>}
        description={
          <IntegrationCardDescription
            i18nPrefix="settings.nightscout"
            provider="nightscout"
          />
        }
        loading={viewModel === undefined}
        connected={false}
        health={null}
        setup={form}
      />
    );
  }

  const menu: IntegrationMenuAction[] = [
    ...(operatorApprovalRequired
      ? []
      : [
          {
            id: "sync",
            label: t("settings.nightscoutSync"),
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
        ]),
    {
      id: "view-data",
      label: t("settings.nightscoutViewData"),
      icon: ArrowRight,
      href: "/insights/blood-glucose",
    },
    {
      id: "credentials",
      label: t("settings.integrationCard.menu.address"),
      icon: KeyRound,
      onSelect: () => setEditing((open) => !open),
    },
    {
      id: "setup-guide",
      label: t("settings.integrationSetupGuide"),
      icon: BookOpen,
      href: integrationDocsHref("nightscout"),
      external: true,
    },
    {
      id: "disconnect",
      label: t("settings.nightscoutDisconnect"),
      icon: Unlink,
      destructive: true,
      onSelect: () => disconnect.mutate(),
      confirm: {
        title: t("settings.nightscoutDisconnectTitle"),
        body: t("settings.nightscoutDisconnectDescription"),
        confirmLabel: t("settings.nightscoutDisconnect"),
      },
    },
  ];

  const streak = failureStreakFor(status);

  return (
    <IntegrationCard
      provider="nightscout"
      providerName={t("settings.nightscout")}
      icon={Droplet}
      titleAccessory={<TagChip>{t("settings.nightscoutTag")}</TagChip>}
      connected
      health={status?.health ?? null}
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
        status?.metricFreshness?.length ? (
          <MetricFreshnessList entries={status.metricFreshness} />
        ) : undefined
      }
    >
      {operatorApprovalRequired ? (
        // The one fact the generic sentence cannot carry: the instance sits
        // on a private network the operator has not approved, which the
        // person cannot fix from here. Said in the body, not as a banner.
        <p
          className="text-sm"
          data-testid="nightscout-private-operator-required"
        >
          {t("settings.nightscoutPrivateOperatorTitle")}{" "}
          {t("settings.nightscoutPrivateOperatorDescription")}
        </p>
      ) : null}
      <ActionResultLines provider="nightscout" sync={sync} test={test} />
      {editing ? form : null}
    </IntegrationCard>
  );
}

function NightscoutForm({
  formRef,
  connected,
  configured,
  hasToken,
}: {
  formRef: React.RefObject<HTMLFormElement | null>;
  connected: boolean;
  configured: boolean;
  hasToken: boolean;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
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
      const res = await apiFetchRaw("/api/nightscout/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim(), token: token.trim() }),
      });
      if (res.ok) {
        setMsg({ kind: "success", text: t("settings.nightscoutConnected") });
        setToken("");
        void invalidateKeys(queryClient, measurementDependentKeys);
        queryClient.invalidateQueries({
          queryKey: queryKeys.integrationsStatus(),
        });
      } else {
        let text = t("settings.nightscoutConnectFailed");
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
      data-testid="nightscout-form"
    >
      <div className="space-y-1.5">
        <Label htmlFor="nightscout-url">{t("settings.nightscoutUrl")}</Label>
        <Input
          id="nightscout-url"
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={
            configured
              ? t("settings.nightscoutUrlSavedPlaceholder")
              : "https://your-site.up.railway.app"
          }
          maxLength={2048}
          autoComplete="off"
          inputMode="url"
          spellCheck={false}
          autoCapitalize="none"
          enterKeyHint="next"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="nightscout-token">
          {t("settings.nightscoutToken")}
        </Label>
        <PasswordInput
          id="nightscout-token"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={
            hasToken
              ? t("settings.nightscoutTokenSavedPlaceholder")
              : t("settings.nightscoutTokenOptional")
          }
          maxLength={512}
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="none"
          enterKeyHint="done"
        />
        <p className="text-muted-foreground text-xs">
          {t("settings.nightscoutTokenHelp")}
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
          disabled={saving || !url.trim()}
          data-slot={connected ? undefined : "integration-primary-action"}
          data-action={connected ? undefined : "connect"}
          data-testid="nightscout-connect"
        >
          {saving ? (
            <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
          ) : connected ? null : (
            <Link2 className="size-3.5" aria-hidden="true" />
          )}
          {connected
            ? t("settings.nightscoutUpdate")
            : t("settings.nightscoutConnect")}
        </Button>
      </SettingsCardActions>
    </form>
  );
}
