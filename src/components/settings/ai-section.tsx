"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  Loader2,
  PlusCircle,
  RefreshCw,
  RotateCcw,
  Save,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { PasswordInput } from "@/components/ui/password-input";
import { useAuth } from "@/hooks/use-auth";
import { formatDateTime } from "@/lib/format";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { toast } from "sonner";

interface InsightsSettings {
  codexStatus: string;
  codexConnectedAt: string | null;
  hasAdminKey: boolean;
  /** True when the operator has set `CODEX_OAUTH_CLIENT_ID` on this
   *  instance. The UI hides the "Connect with ChatGPT" button when
   *  false to avoid the v1.4.2 dead-end where the click bounced the
   *  user to chatgpt.com without any OAuth flow. */
  codexOauthConfigured?: boolean;
  privacyMode: string;
  lastInsightAt: string | null;
}

interface UserAIProvider {
  provider: string | null;
  model: string | null;
  baseUrl: string | null;
  hasAnthropicKey: boolean;
  anthropicKeyPreview: string | null;
  hasLocalKey: boolean;
  hasOpenaiKey: boolean;
  openaiKeyPreview: string | null;
}

/**
 * v1.4.16 phase B2 — provider tags exposed to the UI. Mirrors
 * `PROVIDER_CHAIN_TYPES` server-side; kept as a const-array here to
 * avoid pulling a server-only module into the client bundle.
 */
const PROVIDER_TYPES = [
  "codex",
  "openai",
  "anthropic",
  "local",
  "admin-openai",
] as const;
type ProviderType = (typeof PROVIDER_TYPES)[number];

interface ChainEntry {
  providerType: ProviderType;
  enabled: boolean;
}

interface ProviderChainData {
  activeProvider: ProviderType | null;
  cachedActiveProvider: ProviderType | null;
  configuredChain: {
    providerType: ProviderType;
    enabled: boolean;
    available: boolean;
  }[];
}

const DEFAULT_CHAIN: readonly ChainEntry[] = [
  { providerType: "codex", enabled: true },
  { providerType: "openai", enabled: true },
  { providerType: "anthropic", enabled: true },
  { providerType: "local", enabled: true },
  { providerType: "admin-openai", enabled: true },
];

/**
 * OpenAI model presets — the wire-up keeps users out of the freetext
 * box for the common case. The `__custom__` sentinel surfaces a
 * freetext input so power users can target preview models or
 * fine-tunes (e.g. `gpt-5`, which is admitted via the env override on
 * the Codex backend but not yet a documented OpenAI model id).
 */
const OPENAI_MODEL_PRESETS = ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo"] as const;
const ANTHROPIC_MODEL_PRESETS = [
  "claude-sonnet-4-6",
  "claude-opus-4-7",
  "claude-haiku-4-5",
  "claude-3-5-sonnet-latest",
] as const;
const LOCAL_MODEL_PRESETS = [
  "llama3.1:8b",
  "llama3.1:70b",
  "mistral",
  "qwen2.5",
] as const;
const CUSTOM_MODEL_SENTINEL = "__custom__";

/**
 * Map UI provider tag → the `aiProvider` enum understood by the
 * legacy single-result `resolveProvider()` resolver. `codex` and
 * `admin-openai` aren't user-level provider columns (they're handled
 * by Codex OAuth + admin-key fallback), so they map to null and the
 * legacy column is left blank.
 */
function uiToLegacyProviderEnum(p: ProviderType): string | null {
  switch (p) {
    case "openai":
      return "OPENAI";
    case "anthropic":
      return "ANTHROPIC";
    case "local":
      return "LOCAL";
    case "codex":
    case "admin-openai":
    default:
      return null;
  }
}

export function AiSection() {
  const { t } = useTranslations();
  const { isAuthenticated } = useAuth();

  return (
    <section aria-labelledby="settings-section-ai-title" className="space-y-6">
      <header className="space-y-1">
        <h1
          id="settings-section-ai-title"
          className="text-2xl font-semibold tracking-tight"
        >
          {t("settings.sections.ai.title")}
        </h1>
        <p className="text-muted-foreground text-sm">
          {t("settings.sections.ai.description")}
        </p>
      </header>

      <AiInsightsCard isAuthenticated={isAuthenticated} />

      {/* v1.4.47 W3 — per-user Coach opt-out. Lives below the provider
          card so users who want the surface gone never have to scroll
          through provider configuration before finding the toggle. */}
      <DisableCoachCard isAuthenticated={isAuthenticated} />
    </section>
  );
}

/**
 * v1.4.47 W3 — "Hide Coach" toggle card.
 *
 * Persists via `PATCH /api/auth/me/disable-coach`; the response
 * invalidates `queryKeys.authMe()` so every Coach mount point on the
 * client (`<LayoutCoachFab>`, `<LayoutCoachMount>`, the inline
 * `<CoachLaunchButton>` pill, the `/targets` page CTAs) re-renders
 * with the new `user.disableCoach` value on the next React Query
 * refetch tick — no full reload required.
 *
 * The optimistic-update pattern mirrors `<MoodReminderCard>`: the
 * Switch flips immediately, the mutation rolls back on error.
 */
function DisableCoachCard({ isAuthenticated }: { isAuthenticated: boolean }) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const { user } = useAuth();

  // Optimistic-update flag — null means "no in-flight change",
  // otherwise it overrides the wire value until the mutation
  // settles. Mirrors the `<MoodReminderCard>` pattern so the Switch
  // reacts instantly to the user's tap.
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [msgType, setMsgType] = useState<"success" | "error" | null>(null);

  // v1.4.48 M2 — auto-clear the inline `<p role="status">` line 3 s
  // after the mutation settles so a Settings card the user scrolled
  // past minutes earlier doesn't keep echoing a stale "Coach hidden"
  // banner. The ref tracks the in-flight timer so we can clear it on
  // unmount + on a follow-up toggle (otherwise a rapid double-tap
  // could leave a stray timer pointing at a stale message).
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (clearTimerRef.current !== null) {
        clearTimeout(clearTimerRef.current);
        clearTimerRef.current = null;
      }
    };
  }, []);

  function scheduleClear() {
    if (clearTimerRef.current !== null) {
      clearTimeout(clearTimerRef.current);
    }
    clearTimerRef.current = setTimeout(() => {
      clearTimerRef.current = null;
      setMsg(null);
      setMsgType(null);
    }, 3000);
  }

  const checked = optimistic ?? user?.disableCoach ?? false;

  const mutation = useMutation({
    mutationFn: async (next: boolean) => {
      const res = await fetch("/api/auth/me/disable-coach", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ disableCoach: next }),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      return next;
    },
    onSuccess: (next) => {
      setMsg(
        next
          ? t("settings.ai.disableCoach.savedHidden")
          : t("settings.ai.disableCoach.savedShown"),
      );
      setMsgType("success");
      // Surface the new value to every Coach gate via the shared
      // `useAuth()` query — the gates re-render once React Query
      // re-fetches /api/auth/me with the updated `disableCoach` field.
      queryClient.invalidateQueries({ queryKey: queryKeys.authMe() });
      setOptimistic(null);
      scheduleClear();
    },
    onError: (err) => {
      setOptimistic(null);
      setMsg(
        err instanceof Error
          ? err.message
          : t("settings.ai.disableCoach.saveError"),
      );
      setMsgType("error");
      scheduleClear();
    },
  });

  function handleToggle(next: boolean) {
    setOptimistic(next);
    setMsg(null);
    setMsgType(null);
    if (clearTimerRef.current !== null) {
      clearTimeout(clearTimerRef.current);
      clearTimerRef.current = null;
    }
    mutation.mutate(next);
  }

  return (
    <section
      aria-labelledby="settings-ai-disable-coach-title"
      data-testid="settings-disable-coach-card"
      className="bg-card border-border space-y-3 rounded-xl border p-6"
    >
      <div className="flex items-center justify-between gap-4">
        <div className="pr-2">
          <h2
            id="settings-ai-disable-coach-title"
            className="text-base font-semibold"
          >
            {t("settings.ai.disableCoach.title")}
          </h2>
          <p className="text-muted-foreground text-xs">
            {t("settings.ai.disableCoach.description")}
          </p>
        </div>
        <Switch
          data-testid="settings-disable-coach-switch"
          checked={checked}
          onCheckedChange={handleToggle}
          disabled={!isAuthenticated || mutation.isPending}
          aria-label={t("settings.ai.disableCoach.toggleAria")}
        />
      </div>
      {msg && (
        <p
          role="status"
          aria-live="polite"
          className={
            msgType === "error"
              ? "text-destructive text-xs"
              : "text-muted-foreground text-xs"
          }
        >
          {msg}
        </p>
      )}
    </section>
  );
}

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
function AiInsightsCard({ isAuthenticated }: { isAuthenticated: boolean }) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const { data: insightsSettings } = useQuery({
    queryKey: queryKeys.insightsSettings(),
    queryFn: async () => {
      const res = await fetch("/api/insights/settings");
      if (!res.ok) return null;
      const json = await res.json();
      return json.data as InsightsSettings;
    },
    enabled: isAuthenticated,
  });

  const { data: userProvider } = useQuery({
    queryKey: queryKeys.userAiProvider(),
    queryFn: async () => {
      const res = await fetch("/api/user/ai-provider");
      if (!res.ok) return null;
      const json = await res.json();
      return json.data as UserAIProvider;
    },
    enabled: isAuthenticated,
  });

  const { data: chainData } = useQuery({
    queryKey: queryKeys.insightsProviderChain(),
    queryFn: async () => {
      const res = await fetch("/api/insights/provider-chain");
      if (!res.ok) return null;
      const json = await res.json();
      return json.data as ProviderChainData;
    },
    enabled: isAuthenticated,
  });

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

  return (
    <div className="bg-card border-border space-y-4 rounded-xl border p-6">
      {/* v1.4.33 IW7 — the dedicated H2 ("KI-Insights") used to repeat
          the parent section title ("KI-Auswertungen"). Both are gone now:
          the section renders "Auswertungen" once at the top, and this
          card carries only the Sparkles icon + the live provider-status
          badges, mirroring the description that lives on the section
          header. The configuration description is moved one level up
          into the section subtitle so the visual hierarchy stays
          two-level (section -> form) instead of three-level
          (section -> card title -> form). */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Sparkles className="text-primary h-5 w-5" aria-hidden="true" />
        <ProviderStatusBadges
          settings={insightsSettings}
          activeProvider={chainData?.activeProvider ?? null}
        />
      </div>
      <p className="text-muted-foreground text-xs">
        {t("settings.kiInsightsDescription")}
      </p>

      <ActiveProviderSelect value={selectedProvider} onChange={pickProvider} />

      <ProviderConfigCard
        provider={selectedProvider}
        insightsSettings={insightsSettings}
        userProvider={userProvider}
      />

      <FallbackChainCard
        chain={chainData?.configuredChain ?? []}
        selected={selectedProvider}
        onSelect={pickProvider}
      />

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
          queryClient.invalidateQueries({ queryKey: queryKeys.insightsRoot() })
        }
        onPrivacyChanged={() =>
          queryClient.invalidateQueries({ queryKey: queryKeys.insightsRoot() })
        }
      />
    </div>
  );
}

function isProviderType(v: string | null): v is ProviderType {
  return v != null && (PROVIDER_TYPES as readonly string[]).includes(v);
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
          <Badge className="border-dracula-purple/30 bg-dracula-purple/15 text-dracula-purple">
            {t("settings.ai.adminAiActiveBadge")}
          </Badge>
        )}
      {settings?.codexStatus === "expired" && (
        <Badge className="border-warning/30 bg-warning/15 text-warning">
          {t("settings.ai.connectionExpiredBadge")}
        </Badge>
      )}
      {settings?.lastInsightAt && (
        <Badge variant="outline" className="text-xs">
          {t("settings.lastGeneratedAt")}:{" "}
          {formatDateTime(settings.lastInsightAt)}
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
    <div className="bg-muted/50 rounded-lg p-4">
      <p className="text-sm font-medium">
        {t("settings.ai.activeProviderHeading")}
      </p>
      <p className="text-muted-foreground mb-3 text-xs">
        {t("settings.ai.activeProviderBody")}
      </p>
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
        className="mt-1 sm:max-w-md"
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
  const { t } = useTranslations();
  return (
    <div className="bg-muted/50 space-y-4 rounded-lg p-4">
      <p className="text-sm font-medium">
        {t("settings.ai.providerConfigTitle")}
      </p>
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
      {provider === "admin-openai" && (
        <AdminOpenAIProviderForm hasAdminKey={insightsSettings?.hasAdminKey} />
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────
 * Codex (ChatGPT account) form — connect / disconnect / status.
 * ──────────────────────────────────────────────────────────────── */

function CodexProviderForm({
  settings,
}: {
  settings: InsightsSettings | null | undefined;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();

  const [msg, setMsg] = useState<string | null>(null);
  const [msgType, setMsgType] = useState<"success" | "error" | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const [deviceCode, setDeviceCode] = useState<{
    userCode: string;
    verificationUrl: string;
    intervalSeconds: number;
  } | null>(null);
  const [devicePolling, setDevicePolling] = useState(false);

  // OAuth callback handler — reads `?codex_connected=true|codex_error=…`
  // from the URL and surfaces an inline message.
  const [oauthOutcome] = useState<
    { kind: "connected" } | { kind: "error" } | null
  >(() => {
    if (typeof window === "undefined") return null;
    const params = new URLSearchParams(window.location.search);
    if (params.get("codex_connected") === "true") return { kind: "connected" };
    if (params.get("codex_error")) return { kind: "error" };
    return null;
  });

  useEffect(() => {
    if (!oauthOutcome) return;
    const url = new URL(window.location.href);
    url.searchParams.delete("codex_connected");
    url.searchParams.delete("codex_error");
    window.history.replaceState({}, "", url.toString());
    if (oauthOutcome.kind === "connected") {
      queryClient.invalidateQueries({ queryKey: queryKeys.insightsRoot() });
    }
  }, [oauthOutcome, queryClient]);

  const [oauthMsgSeeded, setOauthMsgSeeded] = useState(false);
  if (!oauthMsgSeeded && oauthOutcome) {
    setOauthMsgSeeded(true);
    if (oauthOutcome.kind === "connected") {
      setMsg(t("settings.codexConnected"));
      setMsgType("success");
    } else {
      setMsg(t("settings.codexConnectionFailed"));
      setMsgType("error");
    }
  }

  async function handleConnect() {
    setMsg(null);
    setDevicePolling(true);
    try {
      const res = await fetch("/api/auth/codex/device-start", {
        method: "POST",
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || t("settings.savingError"));
      setDeviceCode({
        userCode: json.data.userCode,
        verificationUrl: json.data.verificationUrl,
        intervalSeconds: json.data.intervalSeconds,
      });
    } catch (err) {
      setMsg(err instanceof Error ? err.message : t("settings.savingError"));
      setMsgType("error");
      setDevicePolling(false);
    }
  }

  useEffect(() => {
    if (!deviceCode) return;
    let cancelled = false;
    const intervalMs = Math.max(deviceCode.intervalSeconds, 3) * 1000;

    async function tick() {
      try {
        const res = await fetch("/api/auth/codex/device-poll", {
          method: "POST",
        });
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          throw new Error(json.error || t("settings.savingError"));
        }
        if (json.data?.status === "connected") {
          setDeviceCode(null);
          setDevicePolling(false);
          setMsg(t("settings.codexConnected"));
          setMsgType("success");
          queryClient.invalidateQueries({ queryKey: queryKeys.insightsRoot() });
          return;
        }
        if (!cancelled) setTimeout(tick, intervalMs);
      } catch (err) {
        if (cancelled) return;
        setMsg(err instanceof Error ? err.message : t("settings.savingError"));
        setMsgType("error");
        setDeviceCode(null);
        setDevicePolling(false);
      }
    }

    const handle = setTimeout(tick, intervalMs);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceCode]);

  function handleCancelDevice() {
    setDeviceCode(null);
    setDevicePolling(false);
  }

  async function handleDisconnect() {
    setDisconnecting(true);
    setMsg(null);
    try {
      const res = await fetch("/api/auth/codex/disconnect", {
        method: "DELETE",
      });
      if (!res.ok) {
        const json = await res.json();
        throw new Error(json.error);
      }
      setMsg(t("settings.codexDisconnected"));
      setMsgType("success");
      queryClient.invalidateQueries({ queryKey: queryKeys.insightsRoot() });
    } catch (err) {
      setMsg(err instanceof Error ? err.message : t("settings.savingError"));
      setMsgType("error");
    } finally {
      setDisconnecting(false);
    }
  }

  const status = settings?.codexStatus;
  const isConnected = status === "connected";

  return (
    <div data-testid="ai-provider-config-codex" className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">
          {t("settings.ai.codex.modelSlugLabel")}
        </span>
        {isConnected ? (
          <Badge className="border-success/30 bg-success/15 text-success">
            {t("settings.ai.codex.statusConnected")}
          </Badge>
        ) : status === "expired" ? (
          <Badge className="border-warning/30 bg-warning/15 text-warning">
            {t("settings.ai.codex.statusExpired")}
          </Badge>
        ) : (
          <Badge variant="outline">
            {t("settings.ai.codex.statusDisconnected")}
          </Badge>
        )}
      </div>
      <p className="text-muted-foreground text-xs">
        {t("settings.ai.codex.modelSlugBody")}
      </p>
      {settings?.lastInsightAt && (
        <p className="text-muted-foreground text-xs">
          {t("settings.ai.codex.lastInsight", {
            when: formatDateTime(settings.lastInsightAt),
          })}
        </p>
      )}
      {settings?.codexConnectedAt && isConnected && (
        <p className="text-muted-foreground text-xs">
          {t("settings.ai.connectedSince", {
            when: formatDateTime(settings.codexConnectedAt),
          })}
        </p>
      )}

      {settings?.codexOauthConfigured === false ? (
        <p className="text-muted-foreground text-xs italic">
          {t("settings.ai.oauthNotConfigured")}
        </p>
      ) : isConnected ? (
        <Button
          variant="outline"
          size="sm"
          className="text-destructive shrink-0"
          onClick={handleDisconnect}
          disabled={disconnecting}
        >
          {disconnecting ? (
            <Loader2 className="mr-1 h-4 w-4 animate-spin motion-reduce:animate-none" />
          ) : (
            <Trash2 className="mr-1 h-4 w-4" />
          )}
          {t("settings.ai.codex.disconnectButton")}
        </Button>
      ) : deviceCode ? (
        <div className="border-dracula-purple bg-dracula-purple/5 space-y-3 rounded-lg border-l-4 p-4">
          <p className="text-sm font-medium">
            {t("settings.ai.deviceCodeHeading")}
          </p>
          <ol className="text-muted-foreground list-decimal space-y-2 pl-5 text-sm">
            <li>
              {t("settings.ai.deviceCodeStep1")}{" "}
              <a
                href={deviceCode.verificationUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-dracula-purple font-medium underline"
              >
                {deviceCode.verificationUrl}
              </a>
            </li>
            <li>
              {t("settings.ai.deviceCodeStep2")}
              <div className="bg-card border-border mt-2 inline-flex items-center gap-2 rounded border px-3 py-2 font-mono text-lg tracking-widest">
                {deviceCode.userCode}
                <button
                  type="button"
                  onClick={() =>
                    navigator.clipboard?.writeText(deviceCode.userCode)
                  }
                  className="text-muted-foreground hover:text-foreground text-xs underline"
                >
                  {t("settings.ai.deviceCodeCopy")}
                </button>
              </div>
            </li>
            <li>{t("settings.ai.deviceCodeStep3")}</li>
          </ol>
          <div className="flex items-center gap-3 text-xs">
            {devicePolling && (
              <span className="text-muted-foreground inline-flex items-center gap-1">
                <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" />
                {t("settings.ai.deviceCodeWaiting")}
              </span>
            )}
            <button
              type="button"
              onClick={handleCancelDevice}
              className="text-muted-foreground hover:text-foreground underline"
            >
              {t("settings.ai.deviceCodeCancel")}
            </button>
          </div>
        </div>
      ) : (
        <Button
          variant="outline"
          onClick={handleConnect}
          disabled={devicePolling}
          className="w-full sm:w-auto"
        >
          {devicePolling ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" />
          ) : (
            <Sparkles className="mr-2 h-4 w-4" />
          )}
          {t("settings.ai.codex.connectButton")}
        </Button>
      )}

      {msg && (
        <p
          role="alert"
          className={`text-sm ${msgType === "success" ? "text-success" : "text-destructive"}`}
        >
          {msg}
        </p>
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────
 * OpenAI form — API key + model select + collapsed Base URL override.
 * Save mutation flips both `aiProvider` (for the legacy single-result
 * resolver) and `aiOpenaiKeyEncrypted` (the user's key) so an OPENAI
 * pick is visible to every code path that reads the row.
 * ──────────────────────────────────────────────────────────────── */

function OpenAIProviderForm({
  userProvider,
}: {
  userProvider: UserAIProvider | null | undefined;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();

  const [apiKey, setApiKey] = useState("");
  const [modelChoice, setModelChoice] = useState<string>("");
  const [customModel, setCustomModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  const seededKey =
    userProvider != null
      ? `${userProvider.provider ?? ""}|${userProvider.model ?? ""}|${userProvider.baseUrl ?? ""}`
      : null;
  const [previousSeed, setPreviousSeed] = useState<string | null>(null);
  if (seededKey && seededKey !== previousSeed) {
    setPreviousSeed(seededKey);
    if (userProvider?.provider === "OPENAI") {
      const saved = userProvider.model ?? "";
      if (
        saved &&
        (OPENAI_MODEL_PRESETS as readonly string[]).includes(saved)
      ) {
        setModelChoice(saved);
        setCustomModel("");
      } else if (saved) {
        setModelChoice(CUSTOM_MODEL_SENTINEL);
        setCustomModel(saved);
      }
      setBaseUrl(userProvider.baseUrl ?? "");
    }
  }

  const effectiveModel =
    modelChoice === CUSTOM_MODEL_SENTINEL
      ? customModel.trim()
      : modelChoice.trim();

  const saveMutation = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        provider: uiToLegacyProviderEnum("openai"),
        model: effectiveModel || null,
        baseUrl: baseUrl.trim() || null,
      };
      if (apiKey.trim()) body.openaiKey = apiKey.trim();
      const res = await fetch("/api/user/ai-provider", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || t("settings.ai.saveFailed"));
    },
    onSuccess: () => {
      setOk(true);
      setMsg(t("settings.ai.saved"));
      setApiKey("");
      queryClient.invalidateQueries({ queryKey: queryKeys.userAiProvider() });
      queryClient.invalidateQueries({ queryKey: queryKeys.insightsRoot() });
    },
    onError: (e) => {
      setOk(false);
      setMsg(e instanceof Error ? e.message : t("settings.ai.errorGeneric"));
    },
  });

  return (
    <div data-testid="ai-provider-config-openai" className="space-y-4">
      <div>
        <Label htmlFor="ai-openai-key">
          {t("settings.ai.openai.apiKey")}
          {userProvider?.hasOpenaiKey && (
            <span className="text-muted-foreground ml-2 text-xs">
              {t("settings.ai.savedPreview", {
                preview: userProvider.openaiKeyPreview ?? "",
              })}
            </span>
          )}
        </Label>
        <PasswordInput
          id="ai-openai-key"
          data-testid="ai-openai-api-key"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={t("settings.ai.openai.apiKeyPlaceholder")}
          className="mt-1"
        />
      </div>

      <div>
        <Label htmlFor="ai-openai-model">
          {t("settings.ai.openai.modelSelect")}
        </Label>
        <NativeSelect
          id="ai-openai-model"
          data-testid="ai-openai-model"
          value={modelChoice}
          onChange={(e) => setModelChoice(e.target.value)}
          className="mt-1"
        >
          <option value="">{t("settings.ai.modelOptionDefault")}</option>
          {OPENAI_MODEL_PRESETS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
          <option value={CUSTOM_MODEL_SENTINEL}>
            {t("settings.ai.openai.modelOptionCustom")}
          </option>
        </NativeSelect>
      </div>

      {modelChoice === CUSTOM_MODEL_SENTINEL && (
        <div>
          <Label htmlFor="ai-openai-model-custom">
            {t("settings.ai.openai.modelCustomLabel")}
          </Label>
          <Input
            id="ai-openai-model-custom"
            value={customModel}
            onChange={(e) => setCustomModel(e.target.value)}
            placeholder={t("settings.ai.openai.modelCustomPlaceholder")}
            className="mt-1"
          />
        </div>
      )}

      <div>
        <button
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          className="text-muted-foreground hover:text-foreground text-xs underline"
        >
          {showAdvanced
            ? t("settings.ai.openai.hideAdvanced")
            : t("settings.ai.openai.showAdvanced")}
        </button>
        {showAdvanced && (
          <div className="mt-2 space-y-1">
            <Label htmlFor="ai-openai-base-url">
              {t("settings.ai.openai.baseUrlLabel")}
            </Label>
            <Input
              id="ai-openai-base-url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={t("settings.ai.openai.baseUrlPlaceholder")}
            />
            <p className="text-muted-foreground text-xs">
              {t("settings.ai.openai.baseUrlHelp")}
            </p>
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          onClick={() => saveMutation.mutate()}
          disabled={saveMutation.isPending}
        >
          {saveMutation.isPending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" />
          ) : (
            <Save className="mr-2 h-4 w-4" />
          )}
          {t("settings.ai.saveCta")}
        </Button>
      </div>

      {msg && (
        <p className={`text-xs ${ok ? "text-success" : "text-destructive"}`}>
          {msg}
        </p>
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────
 * Anthropic form — API key + model dropdown.
 * ──────────────────────────────────────────────────────────────── */

function AnthropicProviderForm({
  userProvider,
}: {
  userProvider: UserAIProvider | null | undefined;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();

  const [apiKey, setApiKey] = useState("");
  const [modelChoice, setModelChoice] = useState<string>("");
  const [customModel, setCustomModel] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  const seededKey =
    userProvider != null
      ? `${userProvider.provider ?? ""}|${userProvider.model ?? ""}`
      : null;
  const [previousSeed, setPreviousSeed] = useState<string | null>(null);
  if (seededKey && seededKey !== previousSeed) {
    setPreviousSeed(seededKey);
    if (userProvider?.provider === "ANTHROPIC") {
      const saved = userProvider.model ?? "";
      if (
        saved &&
        (ANTHROPIC_MODEL_PRESETS as readonly string[]).includes(saved)
      ) {
        setModelChoice(saved);
        setCustomModel("");
      } else if (saved) {
        setModelChoice(CUSTOM_MODEL_SENTINEL);
        setCustomModel(saved);
      }
    }
  }

  const effectiveModel =
    modelChoice === CUSTOM_MODEL_SENTINEL
      ? customModel.trim()
      : modelChoice.trim();

  const saveMutation = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        provider: uiToLegacyProviderEnum("anthropic"),
        model: effectiveModel || null,
      };
      if (apiKey.trim()) body.anthropicKey = apiKey.trim();
      const res = await fetch("/api/user/ai-provider", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || t("settings.ai.saveFailed"));
    },
    onSuccess: () => {
      setOk(true);
      setMsg(t("settings.ai.saved"));
      setApiKey("");
      queryClient.invalidateQueries({ queryKey: queryKeys.userAiProvider() });
      queryClient.invalidateQueries({ queryKey: queryKeys.insightsRoot() });
    },
    onError: (e) => {
      setOk(false);
      setMsg(e instanceof Error ? e.message : t("settings.ai.errorGeneric"));
    },
  });

  return (
    <div data-testid="ai-provider-config-anthropic" className="space-y-4">
      <div>
        <Label htmlFor="ai-anthropic-key">
          {t("settings.ai.anthropicKeyLabel")}
          {userProvider?.hasAnthropicKey && (
            <span className="text-muted-foreground ml-2 text-xs">
              {t("settings.ai.savedPreview", {
                preview: userProvider.anthropicKeyPreview ?? "",
              })}
            </span>
          )}
        </Label>
        <PasswordInput
          id="ai-anthropic-key"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="sk-ant-…"
          className="mt-1"
        />
      </div>

      <div>
        <Label htmlFor="ai-anthropic-model">
          {t("settings.ai.modelLabel")}
        </Label>
        <NativeSelect
          id="ai-anthropic-model"
          value={modelChoice}
          onChange={(e) => setModelChoice(e.target.value)}
          className="mt-1"
        >
          <option value="">{t("settings.ai.modelOptionDefault")}</option>
          {ANTHROPIC_MODEL_PRESETS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
          <option value={CUSTOM_MODEL_SENTINEL}>
            {t("settings.ai.modelOptionCustom")}
          </option>
        </NativeSelect>
      </div>

      {modelChoice === CUSTOM_MODEL_SENTINEL && (
        <div>
          <Label htmlFor="ai-anthropic-model-custom">
            {t("settings.ai.customModelLabel")}
          </Label>
          <Input
            id="ai-anthropic-model-custom"
            value={customModel}
            onChange={(e) => setCustomModel(e.target.value)}
            placeholder="claude-3-5-sonnet-latest"
            className="mt-1"
          />
        </div>
      )}

      <div>
        <Button
          size="sm"
          onClick={() => saveMutation.mutate()}
          disabled={saveMutation.isPending}
        >
          {saveMutation.isPending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" />
          ) : (
            <Save className="mr-2 h-4 w-4" />
          )}
          {t("settings.ai.saveCta")}
        </Button>
      </div>

      {msg && (
        <p className={`text-xs ${ok ? "text-success" : "text-destructive"}`}>
          {msg}
        </p>
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────
 * Local (OpenAI-compatible) form — base URL + optional key + model.
 * ──────────────────────────────────────────────────────────────── */

function LocalProviderForm({
  userProvider,
}: {
  userProvider: UserAIProvider | null | undefined;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();

  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [modelChoice, setModelChoice] = useState<string>("");
  const [customModel, setCustomModel] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  const seededKey =
    userProvider != null
      ? `${userProvider.provider ?? ""}|${userProvider.model ?? ""}|${userProvider.baseUrl ?? ""}`
      : null;
  const [previousSeed, setPreviousSeed] = useState<string | null>(null);
  if (seededKey && seededKey !== previousSeed) {
    setPreviousSeed(seededKey);
    if (userProvider?.provider === "LOCAL") {
      setBaseUrl(userProvider.baseUrl ?? "");
      const saved = userProvider.model ?? "";
      if (saved && (LOCAL_MODEL_PRESETS as readonly string[]).includes(saved)) {
        setModelChoice(saved);
        setCustomModel("");
      } else if (saved) {
        setModelChoice(CUSTOM_MODEL_SENTINEL);
        setCustomModel(saved);
      }
    }
  }

  const effectiveModel =
    modelChoice === CUSTOM_MODEL_SENTINEL
      ? customModel.trim()
      : modelChoice.trim();

  const saveMutation = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        provider: uiToLegacyProviderEnum("local"),
        baseUrl: baseUrl.trim() || null,
        model: effectiveModel || null,
      };
      if (apiKey.trim()) body.localKey = apiKey.trim();
      const res = await fetch("/api/user/ai-provider", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || t("settings.ai.saveFailed"));
    },
    onSuccess: () => {
      setOk(true);
      setMsg(t("settings.ai.saved"));
      setApiKey("");
      queryClient.invalidateQueries({ queryKey: queryKeys.userAiProvider() });
      queryClient.invalidateQueries({ queryKey: queryKeys.insightsRoot() });
    },
    onError: (e) => {
      setOk(false);
      setMsg(e instanceof Error ? e.message : t("settings.ai.errorGeneric"));
    },
  });

  return (
    <div data-testid="ai-provider-config-local" className="space-y-4">
      <div>
        <Label htmlFor="ai-local-base-url">
          {t("settings.ai.baseUrlLabel")}
        </Label>
        <Input
          id="ai-local-base-url"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="http://localhost:11434/v1"
          className="mt-1"
        />
      </div>
      <div>
        <Label htmlFor="ai-local-key">{t("settings.ai.localKeyLabel")}</Label>
        <PasswordInput
          id="ai-local-key"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={
            userProvider?.hasLocalKey ? t("settings.ai.savedShort") : ""
          }
          className="mt-1"
        />
      </div>
      <div>
        <Label htmlFor="ai-local-model">{t("settings.ai.modelLabel")}</Label>
        <NativeSelect
          id="ai-local-model"
          value={modelChoice}
          onChange={(e) => setModelChoice(e.target.value)}
          className="mt-1"
        >
          <option value="">{t("settings.ai.modelOptionDefault")}</option>
          {LOCAL_MODEL_PRESETS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
          <option value={CUSTOM_MODEL_SENTINEL}>
            {t("settings.ai.modelOptionCustom")}
          </option>
        </NativeSelect>
      </div>
      {modelChoice === CUSTOM_MODEL_SENTINEL && (
        <div>
          <Label htmlFor="ai-local-model-custom">
            {t("settings.ai.customModelLabel")}
          </Label>
          <Input
            id="ai-local-model-custom"
            value={customModel}
            onChange={(e) => setCustomModel(e.target.value)}
            placeholder="llama3:8b"
            className="mt-1"
          />
        </div>
      )}

      <div>
        <Button
          size="sm"
          onClick={() => saveMutation.mutate()}
          disabled={saveMutation.isPending}
        >
          {saveMutation.isPending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" />
          ) : (
            <Save className="mr-2 h-4 w-4" />
          )}
          {t("settings.ai.saveCta")}
        </Button>
      </div>

      {msg && (
        <p className={`text-xs ${ok ? "text-success" : "text-destructive"}`}>
          {msg}
        </p>
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────
 * Admin OpenAI form — read-only "the operator has set this up".
 * ──────────────────────────────────────────────────────────────── */

function AdminOpenAIProviderForm({
  hasAdminKey,
}: {
  hasAdminKey: boolean | undefined;
}) {
  const { t } = useTranslations();
  return (
    <div data-testid="ai-provider-config-admin-openai" className="space-y-2">
      <p className="text-sm font-medium">
        {t("settings.ai.adminOpenai.title")}
      </p>
      <p className="text-muted-foreground text-xs">
        {hasAdminKey
          ? t("settings.ai.adminOpenai.body")
          : t("settings.ai.adminOpenai.notConfigured")}
      </p>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────
 * Fallback chain card — reorder via arrows, toggle, remove, add,
 * reset. Uses no new dependency (dnd-kit isn't in package.json).
 * ──────────────────────────────────────────────────────────────── */

function FallbackChainCard({
  chain,
  selected,
  onSelect,
}: {
  chain: {
    providerType: ProviderType;
    enabled: boolean;
    available: boolean;
  }[];
  selected: ProviderType;
  onSelect: (next: ProviderType) => void;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();

  // Local working copy. Server-confirmed values arrive via `chain`
  // prop; we keep our own state so the user can shuffle multiple rows
  // before clicking "Save chain order".
  // v1.4.16 phase D reconcile (code-review H2) — `enabled` from the
  // wire is now the canonical state. The GET endpoint surfaces the
  // raw persisted chain so a disabled entry survives the round-trip.
  const seededKey = chain
    .map((c) => `${c.providerType}:${c.enabled ? 1 : 0}`)
    .join(",");
  const [seeded, setSeeded] = useState<string | null>(null);
  const [entries, setEntries] = useState<ChainEntry[]>(() =>
    chain.map((c) => ({ providerType: c.providerType, enabled: c.enabled })),
  );
  if (seededKey !== seeded) {
    setSeeded(seededKey);
    setEntries(
      chain.map((c) => ({
        providerType: c.providerType,
        enabled: c.enabled,
      })),
    );
  }

  const [msg, setMsg] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  const saveMutation = useMutation({
    mutationFn: async (next: ChainEntry[]) => {
      const body = {
        chain: next.map((entry, idx) => ({
          providerType: entry.providerType,
          priority: idx + 1,
          enabled: entry.enabled,
        })),
      };
      const res = await fetch("/api/insights/provider-chain", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(
          json.error || t("settings.ai.providerChain.saveFailed"),
        );
      }
    },
    onSuccess: () => {
      setOk(true);
      setMsg(t("settings.ai.providerChain.saved"));
      queryClient.invalidateQueries({ queryKey: queryKeys.insightsRoot() });
    },
    onError: (e) => {
      setOk(false);
      setMsg(
        e instanceof Error
          ? e.message
          : t("settings.ai.providerChain.saveFailed"),
      );
    },
  });

  function move(idx: number, delta: -1 | 1) {
    setEntries((prev) => {
      const next = [...prev];
      const target = idx + delta;
      if (target < 0 || target >= next.length) return prev;
      [next[idx], next[target]] = [next[target], next[idx]];
      return next;
    });
  }

  function toggle(idx: number) {
    setEntries((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], enabled: !next[idx].enabled };
      return next;
    });
  }

  function remove(idx: number) {
    setEntries((prev) => prev.filter((_, i) => i !== idx));
  }

  const present = useMemo(
    () => new Set(entries.map((e) => e.providerType)),
    [entries],
  );
  const addable = PROVIDER_TYPES.filter((p) => !present.has(p));

  function add(p: ProviderType) {
    setEntries((prev) => [...prev, { providerType: p, enabled: true }]);
  }

  function resetToDefaults() {
    setEntries(DEFAULT_CHAIN.map((d) => ({ ...d })));
  }

  return (
    <div
      data-testid="ai-fallback-chain"
      className="bg-muted/50 space-y-3 rounded-lg p-4"
    >
      <div>
        <p className="text-sm font-medium">
          {t("settings.ai.providerChain.title")}
        </p>
        <p className="text-muted-foreground text-xs">
          {t("settings.ai.providerChain.description")}
        </p>
      </div>

      <ul className="space-y-2">
        {entries.map((entry, idx) => (
          <li
            key={entry.providerType}
            data-chain-row={entry.providerType}
            className={`bg-card border-border flex flex-wrap items-center gap-2 rounded-md border p-2 ${
              entry.providerType === selected
                ? "border-primary/40 ring-primary/30 ring-1"
                : ""
            }`}
          >
            <span className="text-muted-foreground w-5 text-center text-xs tabular-nums">
              {idx + 1}.
            </span>
            <button
              type="button"
              onClick={() => onSelect(entry.providerType)}
              className="flex-1 text-left text-sm font-medium hover:underline"
            >
              {t(`settings.ai.providerChain.types.${entry.providerType}`)}
            </button>
            <Switch
              checked={entry.enabled}
              onCheckedChange={() => toggle(idx)}
              aria-label={t(
                `settings.ai.providerChain.types.${entry.providerType}`,
              )}
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              aria-label={t("settings.ai.providerChain.moveUp")}
              disabled={idx === 0}
              onClick={() => move(idx, -1)}
            >
              <ArrowUp className="h-4 w-4" />
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              aria-label={t("settings.ai.providerChain.moveDown")}
              disabled={idx === entries.length - 1}
              onClick={() => move(idx, 1)}
            >
              <ArrowDown className="h-4 w-4" />
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              aria-label={t("settings.ai.providerChain.removeFromChain")}
              className="text-destructive"
              onClick={() => remove(idx)}
              disabled={entries.length <= 1}
            >
              <X className="h-4 w-4" />
            </Button>
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-center gap-2">
        {addable.length > 0 ? (
          <AddProviderControl addable={addable} onAdd={add} />
        ) : (
          <p className="text-muted-foreground text-xs italic">
            {t("settings.ai.providerChain.addNoneAvailable")}
          </p>
        )}
        <Button
          size="sm"
          onClick={() => saveMutation.mutate(entries)}
          disabled={saveMutation.isPending || entries.length === 0}
          data-testid="ai-fallback-chain-save"
        >
          {saveMutation.isPending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" />
          ) : (
            <Save className="mr-2 h-4 w-4" />
          )}
          {t("settings.ai.providerChain.saveOrder")}
        </Button>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button size="sm" variant="outline">
              <RotateCcw className="mr-2 h-4 w-4" />
              {t("settings.ai.providerChain.resetDefaults")}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t("settings.ai.providerChain.resetConfirmTitle")}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t("settings.ai.providerChain.resetConfirmBody")}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
              <AlertDialogAction onClick={resetToDefaults}>
                {t("settings.ai.providerChain.resetDefaults")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>

      {msg && (
        <p className={`text-xs ${ok ? "text-success" : "text-destructive"}`}>
          {msg}
        </p>
      )}
    </div>
  );
}

function AddProviderControl({
  addable,
  onAdd,
}: {
  addable: readonly ProviderType[];
  onAdd: (p: ProviderType) => void;
}) {
  const { t } = useTranslations();
  const [picked, setPicked] = useState<string>(addable[0] ?? "");

  return (
    <div className="flex items-center gap-2">
      <NativeSelect
        aria-label={t("settings.ai.providerChain.addProvider")}
        value={picked}
        onChange={(e) => setPicked(e.target.value)}
        className="w-auto"
      >
        {addable.map((p) => (
          <option key={p} value={p}>
            {t(`settings.ai.providerChain.types.${p}`)}
          </option>
        ))}
      </NativeSelect>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => {
          if (isProviderType(picked)) onAdd(picked);
        }}
      >
        <PlusCircle className="mr-2 h-4 w-4" />
        {t("settings.ai.providerChain.addProvider")}
      </Button>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────
 * Runtime actions — Test active provider, regenerate insights, raw-mode toggle.
 * ──────────────────────────────────────────────────────────────── */

function RuntimeActionsRow({
  provider,
  userProvider,
  canRegenerate,
  privacyMode,
  lastInsightAt,
  onRegenerated,
  onPrivacyChanged,
}: {
  provider: ProviderType;
  userProvider: UserAIProvider | null | undefined;
  canRegenerate: boolean;
  privacyMode: string;
  lastInsightAt: string | null;
  onRegenerated: () => void;
  onPrivacyChanged: () => void;
}) {
  const { t } = useTranslations();

  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<string | null>(null);
  const [testOk, setTestOk] = useState(false);
  const [regen, setRegen] = useState(false);
  const [regenMsg, setRegenMsg] = useState<string | null>(null);
  const [regenOk, setRegenOk] = useState(false);

  async function runTest() {
    setTesting(true);
    setTestMsg(null);
    try {
      const res = await fetch("/api/ai/test", { method: "POST" });
      const json = await res.json();
      if (!res.ok) {
        setTestOk(false);
        setTestMsg(
          t("settings.ai.testFailedShort", {
            message: json.error ?? `HTTP ${res.status}`,
          }),
        );
        return;
      }
      setTestOk(true);
      setTestMsg(
        t("settings.ai.testSuccess", {
          provider: json.data.providerType,
          model: json.data.model,
        }),
      );
    } catch (e) {
      setTestOk(false);
      setTestMsg(
        t("settings.ai.testFailedShort", {
          message: e instanceof Error ? e.message : "fetch error",
        }),
      );
    } finally {
      setTesting(false);
    }
  }

  async function regenerate() {
    setRegen(true);
    setRegenMsg(null);
    try {
      const res = await fetch("/api/insights/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force: true }),
      });
      const json = await res.json();
      if (!res.ok) {
        setRegenOk(false);
        setRegenMsg(
          res.status === 429
            ? t("settings.regenerateRateLimit")
            : json.error || t("settings.savingError"),
        );
        return;
      }
      setRegenOk(true);
      setRegenMsg(t("settings.regenerateSuccess"));
      onRegenerated();
    } catch {
      setRegenOk(false);
      setRegenMsg(t("settings.savingError"));
    } finally {
      setRegen(false);
    }
  }

  async function togglePrivacy() {
    const next = privacyMode === "raw" ? "aggregated" : "raw";
    // Privacy mode is a sensitive control: only reflect the new mode
    // once the server confirms it. A swallowed 4xx/5xx would leave the
    // UI showing a setting the server never accepted.
    try {
      const res = await fetch("/api/insights/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ privacyMode: next }),
      });
      if (!res.ok) throw new Error("request failed");
      onPrivacyChanged();
    } catch {
      toast.error(t("settings.savingError"));
    }
  }

  const lastInsightLine = lastInsightAt
    ? `${t("settings.lastGeneratedAt")}: ${formatDateTime(lastInsightAt)}`
    : null;

  // Reserved for a future iteration that gates the Test button per
  // provider (e.g. disable when admin-openai is selected and no admin
  // key is present). For v1.4.16 the API decides.
  void provider;
  void userProvider;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={runTest}
          disabled={testing}
          data-testid="ai-test-active-provider"
        >
          {testing ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" />
          ) : (
            <Sparkles className="mr-2 h-4 w-4" />
          )}
          {t("settings.ai.testProvider")}
        </Button>
        {canRegenerate && (
          <Button
            size="sm"
            variant="outline"
            onClick={regenerate}
            disabled={regen}
          >
            {regen ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" />
            ) : (
              <RefreshCw className="mr-2 h-4 w-4" />
            )}
            {t("settings.regenerateInsights")}
          </Button>
        )}
        {lastInsightLine && (
          <span className="text-muted-foreground text-xs">
            {lastInsightLine}
          </span>
        )}
      </div>

      {canRegenerate && (
        <div className="bg-muted/50 rounded-lg p-3">
          <div className="flex items-center justify-between gap-4">
            <div className="pr-2">
              <p className="text-sm font-medium">{t("settings.rawData")}</p>
              <p className="text-muted-foreground text-xs">
                {privacyMode === "raw"
                  ? t("settings.rawDataOnDescription")
                  : t("settings.rawDataOffDescription")}
              </p>
            </div>
            <Switch
              checked={privacyMode === "raw"}
              onCheckedChange={togglePrivacy}
            />
          </div>
          {privacyMode === "raw" && (
            <div className="bg-warning/15 text-warning mt-2 rounded-lg p-2 text-xs">
              {t("settings.rawDataWarning")}
            </div>
          )}
        </div>
      )}

      {testMsg && (
        <p
          className={`text-xs ${testOk ? "text-success" : "text-destructive"}`}
        >
          {testMsg}
        </p>
      )}
      {regenMsg && (
        <p
          className={`text-xs ${regenOk ? "text-success" : "text-destructive"}`}
        >
          {regenMsg}
        </p>
      )}
    </div>
  );
}
