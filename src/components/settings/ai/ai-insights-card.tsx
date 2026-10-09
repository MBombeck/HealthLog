"use client";

/**
 * The single dropdown-driven configuration card. Replaces the
 * v1.4.15-vintage two-card layout (Codex connect at the top, personal
 * provider form at the bottom) per the maintainer's
 * `feedback_settings_no_split.md`: one provider Select, one matching
 * form below, one fallback-chain card at the bottom.
 *
 * The active-provider Select is URL-synced via `?provider=…` so deep
 * links to a specific config form work, the SSR test can drive the
 * branch deterministically, and a refresh keeps the user on the form
 * they were editing.
 */

import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { MedicalDisclaimer } from "@/components/common/medical-disclaimer";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { apiFetchRaw } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import {
  aiInputDependentKeys,
  invalidateKeys,
  queryKeys,
} from "@/lib/query-keys";

import { AdminOpenAIProviderForm } from "./admin-openai-provider-form";
import { AiConsentCard } from "./ai-consent-card";
import { AnthropicProviderForm } from "./anthropic-provider-form";
import { AutoReadCard } from "./auto-read-card";
import { CentralCodexSwitch } from "./central-codex-switch";
import { CodexProviderForm } from "./codex-provider-form";
import { CompatProviderForm } from "./compat-provider-form";
import { FallbackChainCard } from "./fallback-chain-card";
import { LocalProviderForm } from "./local-provider-form";
import { OpenAIProviderForm } from "./openai-provider-form";
import { ResponseTimeoutCard } from "./response-timeout-card";
import { RuntimeActionsRow } from "./runtime-actions-row";
import {
  PROVIDER_TYPES,
  isProviderType,
  type InsightsSettings,
  type ProviderChainData,
  type ProviderType,
  type UserAIProvider,
} from "./shared";

export function AiInsightsCard({
  isAuthenticated,
}: {
  isAuthenticated: boolean;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // A read failure must surface, not be swallowed into a null that renders the
  // default provider form as if the account were configured that way (§6). The
  // queryFns throw on a non-OK response so the query reports `isError`, and the
  // card paints an honest error instead of a misleading form.
  const {
    data: insightsSettings,
    isPending: settingsPending,
    isError: settingsError,
    refetch: refetchSettings,
  } = useQuery({
    queryKey: queryKeys.insightsSettings(),
    queryFn: async () => {
      const res = await apiFetchRaw("/api/insights/settings");
      if (!res.ok) throw new Error("insights settings read failed");
      const json = await res.json();
      return json.data as InsightsSettings;
    },
    enabled: isAuthenticated,
  });

  const {
    data: userProvider,
    isPending: providerPending,
    isError: providerError,
    refetch: refetchProvider,
  } = useQuery({
    queryKey: queryKeys.userAiProvider(),
    queryFn: async () => {
      const res = await apiFetchRaw("/api/user/ai-provider");
      if (!res.ok) throw new Error("user AI provider read failed");
      const json = await res.json();
      return json.data as UserAIProvider;
    },
    enabled: isAuthenticated,
  });

  const {
    data: chainData,
    isPending: chainPending,
    isError: chainError,
    refetch: refetchChain,
  } = useQuery({
    queryKey: queryKeys.insightsProviderChain(),
    queryFn: async () => {
      const res = await apiFetchRaw("/api/insights/provider-chain");
      if (!res.ok) throw new Error("insights provider chain read failed");
      const json = await res.json();
      return json.data as ProviderChainData;
    },
    enabled: isAuthenticated,
  });

  const hasReadError = settingsError || providerError || chainError;
  // The cards below the provider card size themselves from these reads (the
  // chain rows, the provider form). Painting them before the reads land
  // moved every card under the cursor once they did, so the page holds one
  // placeholder in the provider card until all three have settled.
  const readsPending =
    isAuthenticated && (settingsPending || providerPending || chainPending);
  function retryReads() {
    void refetchSettings();
    void refetchProvider();
    void refetchChain();
  }

  // v1.16.13 — heal the web AI-consent receipt on mount. The server-side
  // consent gate (admin-openai egress) requires an active `ai_full`
  // receipt; the web client never minted one, so existing web users on a
  // shared-key deployment saw the no-key fallback. This mirrors the iOS
  // shell-mount heal: idempotent server-side mint (a user with an active
  // receipt is a no-op), fire-and-forget so a failure never blocks the
  // settings UI. Runs once per mount of the AI-settings surface.
  useEffect(() => {
    if (!isAuthenticated) return;
    // A heal that minted a receipt changed an input of the account's AI
    // capability answer, so `/me` re-resolves; a no-op heal leaves it alone.
    void apiFetchRaw("/api/consent/ai/web", { method: "POST" })
      .then(async (res) => {
        if (!res.ok) return;
        const body = (await res.json()) as { data?: { minted?: boolean } };
        if (body.data?.minted) {
          void invalidateKeys(queryClient, aiInputDependentKeys);
        }
      })
      .catch(() => {
        /* best-effort heal — the explicit grant path stays available */
      });
  }, [isAuthenticated, queryClient]);

  // The Select is URL-driven so the SSR test can pick the branch and
  // a deep link works. Default = `?provider=…` query param when the
  // user navigated here intentionally, else the chain's active entry,
  // else "codex". The seed-on-data-arrival pattern below avoids
  // setState-in-effect (lint rule `react-hooks/set-state-in-effect`)
  // by reading the resolved value at render time and consulting a
  // `seededFor` marker so we only re-seed when the relevant inputs
  // actually changed.
  const queryProvider = searchParams?.get("provider") ?? null;
  const [selectedProvider, setSelectedProvider] = useState<ProviderType>(() =>
    isProviderType(queryProvider) ? queryProvider : "codex",
  );
  const seedKey = `${queryProvider ?? ""}|${chainData?.activeProvider ?? ""}`;
  const [seededFor, setSeededFor] = useState<string>(seedKey);
  if (seedKey !== seededFor) {
    setSeededFor(seedKey);
    if (isProviderType(queryProvider)) {
      setSelectedProvider(queryProvider);
    } else if (chainData?.activeProvider) {
      setSelectedProvider(chainData.activeProvider);
    }
  }

  function pickProvider(next: ProviderType) {
    setSelectedProvider(next);
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    params.set("provider", next);
    router.replace(`${pathname}?${params.toString()}`);
  }

  // v1.42 — one card per concern. The page used to be a single "AI provider"
  // card (repeating the page title) holding seven grey panels, three of them
  // with their own primary Save, each left-aligned mid-card. Every concern is
  // its own Settings card now, each with one action row at its foot
  // (design standards §12/§13).
  return (
    <div className="space-y-6">
      <SettingsCard data-slot="ai-provider-card">
        <SettingsCardHeader
          anchor="ai-provider"
          icon={Sparkles}
          title={t("settings.ai.activeProviderHeading")}
          description={t("settings.ai.providerCardDescription")}
          status={
            <ProviderStatusBadges
              settings={insightsSettings}
              activeProvider={chainData?.activeProvider ?? null}
            />
          }
        />
        {hasReadError ? (
          <QueryErrorCard onRetry={retryReads} />
        ) : readsPending ? (
          <Skeleton className="h-40 w-full rounded-lg" />
        ) : (
          <>
            <ActiveProviderSelect
              value={selectedProvider}
              onChange={pickProvider}
            />
            <ProviderConfigCard
              provider={selectedProvider}
              insightsSettings={insightsSettings}
              userProvider={userProvider}
            />
          </>
        )}
      </SettingsCard>

      {hasReadError || readsPending ? null : (
        <>
          <FallbackChainCard
            chain={chainData?.configuredChain ?? []}
            selected={selectedProvider}
            onSelect={pickProvider}
          />

          {/* v1.22 (#89) — per-user response timeout (mainly for slow
              local/self-hosted backends). */}
          <ResponseTimeoutCard userProvider={userProvider} />

          {/* Read uploaded vault documents automatically with AI (opt-in). */}
          <AutoReadCard />

          {/* Use the operator's shared central Codex connection (opt-in; only
              renders when the operator has connected it). */}
          <CentralCodexSwitch settings={insightsSettings} />

          {/* The standing consent and the one control that withdraws it. It
              sits after the provider cards because it governs all of them. */}
          <AiConsentCard isAuthenticated={isAuthenticated} />

          <RuntimeActionsRow
            provider={selectedProvider}
            userProvider={userProvider}
            canRegenerate={
              insightsSettings?.codexStatus === "connected" ||
              insightsSettings?.hasAdminKey ||
              Boolean(userProvider?.provider)
            }
            privacyMode={insightsSettings?.privacyMode ?? "aggregated"}
            lastInsightAt={insightsSettings?.lastInsightAt ?? null}
            onRegenerated={() =>
              queryClient.invalidateQueries({
                queryKey: queryKeys.insightsRoot(),
              })
            }
            onPrivacyChanged={() =>
              queryClient.invalidateQueries({
                queryKey: queryKeys.insightsRoot(),
              })
            }
            // v1.25 — the data-posture statement lives where the provider
            // key is configured: self-hosted, data stays on this instance,
            // BYOK / local model, no third-party analytics.
            footnote={<MedicalDisclaimer variant="dataPosture" />}
          />
        </>
      )}
    </div>
  );
}

function ProviderStatusBadges({
  settings,
  activeProvider,
}: {
  settings: InsightsSettings | null | undefined;
  activeProvider: ProviderType | null;
}) {
  const { t } = useTranslations();
  return (
    <div className="flex flex-wrap items-center gap-2">
      {settings?.codexStatus === "connected" && activeProvider === "codex" && (
        <Badge className="border-success/30 bg-success/15 text-success">
          {t("settings.ai.chatgptConnectedBadge")}
        </Badge>
      )}
      {settings?.codexStatus !== "connected" &&
        settings?.hasAdminKey &&
        activeProvider !== "codex" && (
          <Badge className="border-primary/30 bg-primary/15 text-primary">
            {t("settings.ai.adminAiActiveBadge")}
          </Badge>
        )}
      {settings?.codexStatus === "expired" && (
        <Badge className="border-warning/30 bg-warning/15 text-warning">
          {t("settings.ai.connectionExpiredBadge")}
        </Badge>
      )}
    </div>
  );
}

/**
 * The single Pulldown that drives every form below it. Uses the
 * shared `<NativeSelect>` primitive so the SSR-only settings test
 * renders deterministically without a portal-based Radix tree, and so
 * the visual contract stays uniform with the other settings pickers
 * that landed behind the same primitive in MB7 / CF-52. Mobile:
 * full-width, height matched to the shared 36 px input contract used
 * everywhere else in Settings; tap target stays comfortable thanks to
 * the full-width chevron region.
 */
function ActiveProviderSelect({
  value,
  onChange,
}: {
  value: ProviderType;
  onChange: (next: ProviderType) => void;
}) {
  const { t } = useTranslations();
  return (
    <div className="space-y-1.5">
      <Label htmlFor="ai-active-provider-select">
        {t("settings.ai.activeProviderLabel")}
      </Label>
      <NativeSelect
        id="ai-active-provider-select"
        data-testid="ai-active-provider-select"
        value={value}
        onChange={(e) => {
          const next = e.target.value;
          if (isProviderType(next)) onChange(next);
        }}
        className="sm:max-w-md"
      >
        {PROVIDER_TYPES.map((p) => (
          <option key={p} value={p}>
            {t(`settings.ai.providerSelect.${p}` as const)}
          </option>
        ))}
      </NativeSelect>
    </div>
  );
}

/**
 * Switch-rendered provider configuration. The component is the
 * "form below adapts dynamically" half of the maintainer's pulldown contract:
 * pick Codex → see Codex form; pick OpenAI → see API-key + model
 * dropdown + base-URL override. The card frame is the same in every
 * branch so transitions feel like updating a single concept rather
 * than swapping pages.
 */
function ProviderConfigCard({
  provider,
  insightsSettings,
  userProvider,
}: {
  provider: ProviderType;
  insightsSettings: InsightsSettings | null | undefined;
  userProvider: UserAIProvider | null | undefined;
}) {
  return (
    <div className="space-y-4" data-slot="ai-provider-config">
      {provider === "codex" && (
        <CodexProviderForm settings={insightsSettings} />
      )}
      {provider === "openai" && (
        <OpenAIProviderForm userProvider={userProvider} />
      )}
      {provider === "anthropic" && (
        <AnthropicProviderForm userProvider={userProvider} />
      )}
      {provider === "local" && (
        <LocalProviderForm userProvider={userProvider} />
      )}
      {provider === "openai-compatible" && (
        <CompatProviderForm userProvider={userProvider} />
      )}
      {provider === "admin-openai" && (
        <AdminOpenAIProviderForm hasAdminKey={insightsSettings?.hasAdminKey} />
      )}
    </div>
  );
}
