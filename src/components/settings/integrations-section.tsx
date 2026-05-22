"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  Download,
  Link2,
  Loader2,
  RefreshCw,
  Save,
  Smile,
  Unlink,
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { TestConnectionButton } from "@/components/settings/test-connection-button";
import { IntegrationStatusPill } from "@/components/settings/integration-status-pill";
import type { IntegrationPillState } from "@/components/settings/integration-status-pill";
import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import {
  invalidateKeys,
  measurementDependentKeys,
  queryKeys,
} from "@/lib/query-keys";

interface MoodLogStatus {
  configured: boolean;
  enabled: boolean;
  lastSyncedAt: string | null;
  entryCount: number;
  webhookSecret: string | null;
}

interface GlobalServiceAvailability {
  telegramGlobal: boolean;
  ntfyGlobal: boolean;
  webPushGlobal: boolean;
  apiGlobal: boolean;
  moodLogGlobal: boolean;
}

// v1.4.15 Phase B2: shared status payload for both integration cards.
// v1.4.19 Phase A5: the redundant in-card status banner is gone — the
// IntegrationStatusPill now owns state + last-sync presentation, and
// the actionable error message is shown inline above the action row.
type IntegrationKey = "withings" | "moodlog";
type IntegrationState =
  | "connected"
  | "error_transient"
  | "error_reauth"
  | "disconnected"
  | "parked";

interface IntegrationStatusViewModel {
  integration: IntegrationKey;
  state: IntegrationState;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  consecutiveFailuresByKind?: {
    transient: number;
    reauth_required: number;
    persistent: number;
  } | null;
  configured?: boolean;
  connected?: boolean;
  connectedAt?: string | null;
  legacyLastSyncedAt?: string | null;
  tokenExpiresAt?: string | null;
  tokenExpired?: boolean | null;
  enabled?: boolean;
}

interface IntegrationStatusEnvelope {
  threshold: number;
  integrations: IntegrationStatusViewModel[];
}

/**
 * Shared status fetch for the Settings → Integrations card. Returns
 * the per-integration view-model AND the global threshold so the
 * "{n}/{threshold} consecutive failures" string in the UI is single-
 * sourced from the server.
 */
function useIntegrationStatuses(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.integrationsStatus(),
    queryFn: async () => {
      const res = await fetch("/api/integrations/status");
      if (!res.ok) throw new Error("Failed");
      return (await res.json()).data as IntegrationStatusEnvelope;
    },
    enabled,
    refetchOnWindowFocus: true,
  });
}

function pickStatus(
  envelope: IntegrationStatusEnvelope | undefined,
  integration: IntegrationKey,
): IntegrationStatusViewModel | undefined {
  return envelope?.integrations.find((i) => i.integration === integration);
}

/**
 * Collapse the API's five-state machine into the four states the
 * pill UI cares about. `error_transient` and `error_reauth` both
 * surface as the same "Error — reconnect" pill, the actionable
 * difference (whether the user must reconnect vs wait for the next
 * retry) is conveyed via the inline error text underneath. `parked`
 * (v1.4.43 W14) is its own pill state — the integration has been
 * disabled after 24h of persistent failures and needs an explicit
 * "Wieder verbinden" click to resume.
 */
function pillStateFor(
  status: IntegrationStatusViewModel | undefined,
): IntegrationPillState {
  if (!status) return "disconnected";
  switch (status.state) {
    case "connected":
      return "connected";
    case "error_transient":
      // v1.4.43 W4 H3 — a `persistent` failure-kind streak (Withings
      // rate-limit 601 / contract-mismatch 293/294) maps to the same
      // `error_transient` DB state as a normal retryable failure but
      // tells the user a different story: the access token still
      // works, the upstream is responding with a non-recoverable
      // status. Surfacing it as a "warning" pill (orange) instead of
      // the red "Fehler — neu verbinden" stops the user from clicking
      // reconnect ten times when reconnect can't fix it.
      if ((status.consecutiveFailuresByKind?.persistent ?? 0) > 0) {
        return "warning";
      }
      return "error";
    case "error_reauth":
      return "error";
    case "parked":
      return "parked";
    case "disconnected":
      return "disconnected";
  }
}

/**
 * Inline actionable error message that surfaces under the pill when a
 * sync attempt failed. The pill conveys "something is wrong"; this
 * line tells the user *what* is wrong so they can act on it. Keeping
 * it deliberately small (one icon + one line) so it doesn't recreate
 * the v1.4.18 redundant banner the maintainer removed.
 */
function IntegrationErrorMessage({ message }: { message: string }) {
  return (
    <p
      data-testid="integration-error-message"
      className="text-destructive flex items-start gap-1.5 text-xs"
    >
      <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 break-words">{message}</span>
    </p>
  );
}

export function IntegrationsSection() {
  const { t } = useTranslations();
  const { isAuthenticated } = useAuth();

  const { data: globalServices } = useQuery({
    queryKey: queryKeys.settingsGlobalServices(),
    queryFn: async () => {
      const res = await fetch("/api/settings/global-services");
      if (!res.ok) throw new Error("Failed");
      return (await res.json()).data as GlobalServiceAvailability;
    },
    enabled: isAuthenticated,
  });

  const { data: integrationStatus } = useIntegrationStatuses(isAuthenticated);

  const moodLogEnabled = globalServices?.moodLogGlobal ?? true;
  const withingsViewModel = pickStatus(integrationStatus, "withings");
  const moodLogViewModel = pickStatus(integrationStatus, "moodlog");

  return (
    <section
      aria-labelledby="settings-section-integrations-title"
      className="space-y-6"
    >
      <header className="space-y-1">
        <h1
          id="settings-section-integrations-title"
          className="text-2xl font-semibold tracking-tight"
        >
          {t("settings.sections.integrations.title")}
        </h1>
        <p className="text-muted-foreground text-sm">
          {t("settings.sections.integrations.description")}
        </p>
      </header>

      <WithingsCard
        isAuthenticated={isAuthenticated}
        viewModel={withingsViewModel}
      />
      {moodLogEnabled && <MoodLogCard viewModel={moodLogViewModel} />}
    </section>
  );
}

function WithingsCard({
  isAuthenticated,
  viewModel,
}: {
  isAuthenticated: boolean;
  viewModel: IntegrationStatusViewModel | undefined;
}) {
  const { t } = useTranslations();
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [syncMsgType, setSyncMsgType] = useState<"success" | "error" | null>(
    null,
  );
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [credsSaving, setCredsSaving] = useState(false);
  const [credsMsg, setCredsMsg] = useState<string | null>(null);
  const [credsMsgType, setCredsMsgType] = useState<"success" | "error" | null>(
    null,
  );
  const queryClient = useQueryClient();

  const { data: status } = useQuery({
    queryKey: queryKeys.withingsStatus(),
    queryFn: async () => {
      const res = await fetch("/api/withings/status");
      if (!res.ok) throw new Error("Failed");
      const json = await res.json();
      return json.data as {
        connected: boolean;
        configured: boolean;
        lastSyncedAt?: string | null;
        connectedAt?: string;
        tokenExpired?: boolean;
        // v1.4.25 W5d — reconnect banner conditional. `null` =
        // legacy v1.4.24 connection without `user.activity`; the
        // user needs to re-auth before steps / active energy /
        // distance / floors ingest unlocks.
        scope?: string | null;
        hasActivityScope?: boolean;
      };
    },
    enabled: isAuthenticated,
  });

  const disconnect = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/withings/disconnect", { method: "POST" });
      if (!res.ok) throw new Error("Failed");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.withings() });
      queryClient.invalidateQueries({ queryKey: queryKeys.integrationsStatus() });
    },
  });

  // v1.4.43 W14 — clear a parked integration via the resume endpoint.
  // The CTA is rendered inside the parked banner below; success
  // invalidates both the per-card status (so the pill flips back to
  // connected immediately) and the cross-integration envelope (so any
  // other view picks up the change on its next focus).
  const resume = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/integrations/withings/resume", {
        method: "POST",
      });
      if (!res.ok) throw new Error("Failed");
      return (await res.json()).data as {
        resumed: boolean;
        wasParked: boolean;
      };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.withings() });
      queryClient.invalidateQueries({ queryKey: queryKeys.integrationsStatus() });
    },
  });

  async function handleSync(fullSync = false) {
    setSyncing(true);
    setSyncMsg(null);
    setSyncMsgType(null);
    try {
      const res = await fetch("/api/withings/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fullSync }),
      });
      const json = await res.json();
      if (res.ok) {
        setSyncMsg(
          fullSync
            ? t("settings.withingsFullSyncResult", {
                count: json.data.imported,
              })
            : t("settings.withingsSyncResult", { count: json.data.imported }),
        );
        setSyncMsgType("success");
        void invalidateKeys(queryClient, measurementDependentKeys);
        queryClient.invalidateQueries({ queryKey: queryKeys.integrationsStatus() });
      } else {
        setSyncMsg(json.error || t("settings.withingsSyncFailed"));
        setSyncMsgType("error");
      }
    } catch {
      setSyncMsg(t("settings.withingsSyncFailed"));
      setSyncMsgType("error");
    } finally {
      setSyncing(false);
    }
  }

  async function handleSaveCredentials(e: React.FormEvent) {
    e.preventDefault();
    setCredsSaving(true);
    setCredsMsg(null);
    setCredsMsgType(null);

    try {
      const res = await fetch("/api/withings/credentials", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: clientId.trim(),
          clientSecret: clientSecret.trim(),
        }),
      });

      if (res.ok) {
        setCredsMsg(t("settings.withingsCredentialsSaved"));
        setCredsMsgType("success");
        setClientId("");
        setClientSecret("");
        queryClient.invalidateQueries({ queryKey: queryKeys.withings() });
      } else {
        try {
          const json = await res.json();
          setCredsMsg(json.error || t("settings.savingError"));
        } catch {
          setCredsMsg(t("settings.savingError"));
        }
        setCredsMsgType("error");
      }
    } catch {
      setCredsMsg(t("common.networkError"));
      setCredsMsgType("error");
    }
    setCredsSaving(false);
  }

  // The pill state derives from the cross-integration status
  // envelope, but the per-card `lastSyncedAt` is sourced from the
  // Withings-specific endpoint so it stays accurate immediately
  // after a manual "Sync now" (which only invalidates the per-card
  // query). When neither endpoint has answered yet we fall back to
  // "disconnected" so the card never renders a status-less header.
  const pillState: IntegrationPillState = status?.connected
    ? pillStateFor(viewModel)
    : "disconnected";
  const pillLastSyncAt =
    status?.lastSyncedAt ?? viewModel?.lastSuccessAt ?? null;
  // v1.4.43 W14 — `parked` and `error` both want the underlying error
  // message surfaced under the pill (the pill says "what" — the
  // message says "why"). Other states leave the inline line off.
  const errorMessage =
    (pillState === "error" || pillState === "parked") && viewModel?.lastError
      ? viewModel.lastError
      : null;

  return (
    <div className="bg-card border-border rounded-xl border p-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <Link2 className="text-primary h-5 w-5" />
          <h2 className="text-lg font-semibold">{t("settings.withings")}</h2>
        </div>
        <IntegrationStatusPill state={pillState} lastSyncAt={pillLastSyncAt} />
      </div>
      <p className="text-muted-foreground mt-1 text-xs">
        {t("settings.withingsDescription")}
      </p>

      <hr
        data-testid="integration-card-divider"
        className="border-border/60 mt-4"
      />

      <div className="mt-4 space-y-4">
        {errorMessage && <IntegrationErrorMessage message={errorMessage} />}
        {/* v1.4.25 W5d — Withings activity-scope reconnect banner.
            Only paints when (a) the user has an active Withings
            connection (so the credentials are already saved + a token
            exists) AND (b) the persisted scope is missing
            `user.activity`. Reconnecting takes the user through the
            standard /api/withings/connect → Withings → callback flow;
            the callback persists the upgraded scope and the banner
            vanishes on the next status poll. */}
        {status?.connected && status?.hasActivityScope === false && (
          <a
            href="/api/withings/connect"
            data-testid="withings-reconnect-banner"
            className="border-warning/30 bg-warning/10 text-warning-foreground hover:bg-warning/20 block rounded-md border px-3 py-2 text-sm transition-colors"
          >
            <span className="font-medium">
              {t("settings.integrations.withings.reconnect.banner.title")}
            </span>
            <span className="text-muted-foreground block text-xs">
              {t("settings.integrations.withings.reconnect.banner.body")}
            </span>
            <span className="text-primary mt-1 inline-block text-xs font-medium">
              {t("settings.integrations.withings.reconnect.banner.action")}
              {" →"}
            </span>
          </a>
        )}
        {/* v1.4.43 W14 — parked-integration resume CTA. Surfaces only
            when the row state is `parked` (>24h of persistent
            failures). The button POSTs to /api/integrations/withings/
            resume which calls `resumeIntegrationFromPark`; on success
            the per-card status invalidates and the pill flips back to
            connected without a page refresh. The button is the
            primary action the user can take from this card — wider
            tap target than the inline action row so it's reachable
            on a Pixel 5 viewport. */}
        {pillState === "parked" && (
          <div
            data-testid="withings-parked-banner"
            className="border-dracula-orange/30 bg-dracula-orange/10 flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm"
          >
            <span className="text-dracula-orange min-w-0 break-words text-xs">
              {t("settings.integrationPill.parkedReconnect")}
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => resume.mutate()}
              disabled={resume.isPending}
              data-testid="withings-resume-button"
              className="min-h-[44px] sm:min-h-0"
            >
              {resume.isPending ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
              ) : (
                <Link2 className="mr-1 h-3.5 w-3.5" />
              )}
              {t("settings.integrationPill.resumeCta")}
            </Button>
          </div>
        )}
        {resume.isError && (
          <p
            role="alert"
            className="text-destructive text-xs"
            data-testid="withings-resume-error"
          >
            {t("settings.integrationPill.resumeError")}
          </p>
        )}
        {resume.isSuccess && resume.data?.wasParked && (
          <p
            role="status"
            className="text-dracula-green text-xs"
            data-testid="withings-resume-success"
          >
            {t("settings.integrationPill.resumeSuccess")}
          </p>
        )}
        <div className="space-y-3">
          <h3 className="text-sm font-semibold">
            {t("settings.withingsCredentials")}
          </h3>
          <form onSubmit={handleSaveCredentials} className="space-y-3">
            {/* v1.4.27 MB7 / CF-53 — the credentials grid drops from
                a 3-column row (client-id / secret / save) to a
                2-column row of inputs at `sm:`, with the Save button
                lifted out into its own row below. The previous
                "invisible Label" hack to align the button with the
                input baselines fell apart on Galaxy Fold; lifting
                the button into a dedicated `flex justify-end` row
                gives it consistent placement on every viewport and
                lets the input pair span the full width. */}
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="w-clientid">
                  {t("settings.withingsClientId")}
                </Label>
                <Input
                  id="w-clientid"
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  placeholder={
                    status?.configured
                      ? t("settings.withingsCredentialsSavedPlaceholder")
                      : t("settings.withingsClientId")
                  }
                  maxLength={200}
                  autoComplete="off"
                  inputMode="text"
                  spellCheck={false}
                  autoCapitalize="none"
                  enterKeyHint="next"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="w-secret">
                  {t("settings.withingsClientSecret")}
                </Label>
                <PasswordInput
                  id="w-secret"
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                  placeholder={
                    status?.configured
                      ? t("settings.withingsCredentialsSavedPlaceholderSecret")
                      : t("settings.withingsClientSecret")
                  }
                  maxLength={200}
                  autoComplete="off"
                  inputMode="text"
                  spellCheck={false}
                  autoCapitalize="none"
                  enterKeyHint="done"
                />
              </div>
            </div>
            <div className="flex justify-end">
              <Button
                type="submit"
                variant="outline"
                size="sm"
                className="w-full sm:w-auto"
                disabled={
                  credsSaving || !clientId.trim() || !clientSecret.trim()
                }
              >
                {credsSaving ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                ) : (
                  <Save className="mr-1 h-3.5 w-3.5" />
                )}
                {t("settings.withingsSaveCredentials")}
              </Button>
            </div>
            {credsMsg && (
              <p
                role="alert"
                className={`text-sm ${credsMsgType === "success" ? "text-dracula-green" : "text-destructive"}`}
              >
                {credsMsg}
              </p>
            )}
          </form>
        </div>

        {status?.connected ? (
          <>
            {/* v1.4.27 MB7 / CF-57 — the action row already wraps via
                `flex-wrap`, but on Pixel 5 the four AlertDialog +
                test-connection triggers each took a fractional slot
                that read jagged. Force each button to a `min-w-[10rem]`
                on `<sm` so they stack two per row at most and fill
                their column cleanly. Tablet+ keeps the inline row. */}
            <div className="flex flex-wrap items-start gap-2 [&>*]:min-w-[10rem] sm:[&>*]:min-w-0">
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleSync(false)}
                disabled={syncing}
              >
                {syncing ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                ) : (
                  <RefreshCw className="mr-1 h-3.5 w-3.5" />
                )}
                {t("settings.withingsSync")}
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="outline" size="sm" disabled={syncing}>
                    {syncing ? (
                      <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                    ) : (
                      <RefreshCw className="mr-1 h-3.5 w-3.5" />
                    )}
                    {t("settings.withingsFullSync")}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      {t("settings.withingsFullSyncTitle")}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {t("settings.withingsFullSyncDescription")}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                    <AlertDialogAction onClick={() => handleSync(true)}>
                      {t("settings.withingsSynchronize")}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
              <TestConnectionButton
                endpoint="/api/integrations/withings/test"
                disabled={!status?.connected}
              />
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-destructive"
                  >
                    <Unlink className="mr-1 h-3.5 w-3.5" />
                    {t("settings.withingsDisconnect")}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      {t("settings.withingsDisconnectTitle")}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {t("settings.withingsDisconnectDescription")}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                    <AlertDialogAction
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      onClick={() => disconnect.mutate()}
                    >
                      {t("settings.withingsDisconnect")}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
            {syncMsg && (
              <p
                role="alert"
                className={`text-sm ${syncMsgType === "success" ? "text-dracula-green" : "text-destructive"}`}
              >
                {syncMsg}
              </p>
            )}
          </>
        ) : status?.configured ? (
          <Button
            variant="outline"
            onClick={() => {
              window.location.href = "/api/withings/connect";
            }}
          >
            <Link2 className="mr-2 h-4 w-4" />
            {t("settings.withingsConnect")}
          </Button>
        ) : (
          <div className="bg-muted/50 text-muted-foreground rounded-lg p-3 text-sm">
            {t("settings.withingsNoCredentials")}
          </div>
        )}
      </div>
    </div>
  );
}

function MoodLogCard({
  viewModel,
}: {
  viewModel: IntegrationStatusViewModel | undefined;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [url, setUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [msgType, setMsgType] = useState<"success" | "error" | null>(null);

  const { data: status, refetch: refetchStatus } = useQuery({
    queryKey: queryKeys.moodlogStatus(),
    queryFn: async () => {
      const res = await fetch("/api/integrations/moodlog/status");
      if (!res.ok) throw new Error("Failed");
      return (await res.json()).data as MoodLogStatus;
    },
  });

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMsg(null);
    const res = await fetch("/api/settings/moodlog", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: url.trim(), apiKey: apiKey.trim() }),
    });
    if (res.ok) {
      setMsg(t("settings.moodLogSaved"));
      setMsgType("success");
      setUrl("");
      setApiKey("");
      await refetchStatus();
      queryClient.invalidateQueries({ queryKey: queryKeys.integrationsStatus() });
    } else {
      const json = await res.json();
      setMsg(json.error || t("settings.savingError"));
      setMsgType("error");
    }
    setSaving(false);
  }

  async function handleSync(fullSync = false) {
    setSyncing(true);
    setMsg(null);
    try {
      const res = await fetch("/api/integrations/moodlog/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fullSync }),
      });
      if (res.ok) {
        const json = await res.json();
        setMsg(
          t("settings.moodLogSyncResult").replace(
            "{count}",
            String(json.data.imported),
          ),
        );
        setMsgType("success");
        await refetchStatus();
        queryClient.invalidateQueries({ queryKey: queryKeys.integrationsStatus() });
      } else {
        setMsg(t("settings.moodLogSyncFailed"));
        setMsgType("error");
      }
    } catch {
      setMsg(t("settings.moodLogSyncFailed"));
      setMsgType("error");
    }
    setSyncing(false);
  }

  async function handleDisconnect() {
    const res = await fetch("/api/settings/moodlog", { method: "DELETE" });
    if (res.ok) {
      setMsg(t("settings.moodLogDisconnected"));
      setMsgType("success");
      await refetchStatus();
      queryClient.invalidateQueries({ queryKey: queryKeys.integrationsStatus() });
    }
  }

  // Mirror Withings logic: the pill state comes from the cross-
  // integration envelope; per-card `lastSyncedAt` from the Mood Log
  // endpoint so a manual sync paints fresh "X min ago" without
  // waiting for the envelope to refetch.
  const pillState: IntegrationPillState = status?.configured
    ? pillStateFor(viewModel)
    : "disconnected";
  const pillLastSyncAt =
    status?.lastSyncedAt ?? viewModel?.lastSuccessAt ?? null;
  const errorMessage =
    pillState === "error" && viewModel?.lastError ? viewModel.lastError : null;

  return (
    <div className="bg-card border-border rounded-xl border p-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <Smile className="text-primary h-5 w-5" />
          <h2 className="text-lg font-semibold">
            <a
              href="https://moodlog.onback.io"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:underline"
            >
              {t("settings.moodLogTitle")}
            </a>
          </h2>
        </div>
        <IntegrationStatusPill state={pillState} lastSyncAt={pillLastSyncAt} />
      </div>
      <p className="text-muted-foreground mt-1 text-xs">
        {t("settings.moodLogDescription")}
      </p>

      {/* v1.4.19 A5 — visual divider matches Withings for consistency
          (the maintainer explicitly called the asymmetry out). */}
      <hr
        data-testid="integration-card-divider"
        className="border-border/60 mt-4"
      />

      <div className="mt-4 space-y-4">
        {errorMessage && <IntegrationErrorMessage message={errorMessage} />}

        <form onSubmit={handleSave} className="space-y-3">
          <div>
            <Label htmlFor="moodlog-url">{t("settings.moodLogUrl")}</Label>
            <Input
              id="moodlog-url"
              type="url"
              placeholder={t("settings.moodLogUrlPlaceholder")}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="none"
              enterKeyHint="next"
            />
          </div>
          <div>
            <Label htmlFor="moodlog-api-key">
              {t("settings.moodLogApiKey")}
            </Label>
            <PasswordInput
              id="moodlog-api-key"
              placeholder={
                status?.configured
                  ? t("settings.withingsCredentialsSavedPlaceholder")
                  : t("settings.moodLogApiKeyPlaceholder")
              }
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              autoComplete="off"
              inputMode="text"
              spellCheck={false}
              autoCapitalize="none"
              enterKeyHint="done"
            />
          </div>
          {/* v1.4.33 — save-button placement contract:
              right-aligned primary `Speichern` with the secondary
              `Verbindung testen` immediately to its left. Mood Log
              used to left-align its row, which was the only
              integration form that did. */}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <TestConnectionButton
              endpoint="/api/integrations/moodlog/test"
              disabled={!status?.configured}
            />
            <Button
              type="submit"
              disabled={saving || (!url.trim() && !apiKey.trim())}
              size="sm"
            >
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" />}
              <Save className="mr-2 h-4 w-4" />
              {t("common.save")}
            </Button>
          </div>
        </form>

        {status?.configured && (
          <div className="space-y-3 border-t pt-3">
            {status.webhookSecret && (
              <div>
                <Label htmlFor="moodlog-webhook-secret">
                  {t("settings.moodLogWebhookSecret")}
                </Label>
                {/* v1.4.33 — the webhook secret is a long hex string;
                    on a 393 CSS px viewport the input + Copy button
                    used to push past the card edge and trigger a body
                    horizontal scroll. Stack vertically on `<sm` and
                    break the input value so it wraps inside its own
                    box. */}
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <Input
                    id="moodlog-webhook-secret"
                    value={status.webhookSecret}
                    readOnly
                    className="font-mono text-xs break-all"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      navigator.clipboard.writeText(status.webhookSecret!);
                      setMsg(t("common.copied"));
                      setMsgType("success");
                    }}
                    className="w-full sm:w-auto"
                  >
                    {/* v1.4.22 D / D-DSGN-M-04 — use the proper
                        common.copy key instead of stripping the
                        exclamation off common.copied. */}
                    {t("common.copy")}
                  </Button>
                </div>
                <p className="text-muted-foreground mt-1 text-xs">
                  {t("settings.moodLogWebhookSecretHelp")}
                </p>
              </div>
            )}

            {/* v1.4.19 A5 — The "letzter Sync" line that used to
                live here is gone. The pill in the card header
                already carries that information; repeating it
                inside the body is the redundancy the maintainer flagged. The
                entry-count is the only number we still surface
                because it's an integration-specific datapoint the
                pill cannot convey. */}
            <div className="flex flex-wrap gap-4 text-sm">
              <span>
                {t("settings.moodLogEntries")}: {status.entryCount}
              </span>
            </div>

            {/* v1.4.33 — the Sync / Voll-Sync / Trennen triplet
                overflowed the card edge on a 393 CSS px viewport
                (~376 px of buttons + gaps inside 345 px of inner
                width). Match the Withings card pattern: `flex-wrap`
                + `min-w-[10rem]` on `<sm` so the triggers stack two
                per row and fill their column cleanly; tablet+ keeps
                the inline row. */}
            <div className="flex flex-wrap items-start gap-2 [&>*]:min-w-[10rem] sm:[&>*]:min-w-0">
              <Button
                variant="outline"
                size="sm"
                disabled={syncing}
                onClick={() => handleSync(false)}
              >
                {syncing && <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" />}
                <RefreshCw className="mr-2 h-4 w-4" />
                {t("settings.moodLogSync")}
              </Button>

              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="outline" size="sm" disabled={syncing}>
                    <Download className="mr-2 h-4 w-4" />
                    {t("settings.moodLogFullSync")}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      {t("settings.moodLogFullSyncTitle")}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {t("settings.moodLogFullSyncDescription")}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                    <AlertDialogAction onClick={() => handleSync(true)}>
                      {t("settings.moodLogFullSyncConfirm")}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>

              <AlertDialog>
                <AlertDialogTrigger asChild>
                  {/* v1.4.3: aligned with the Withings disconnect button —
                      outline + text-destructive instead of solid destructive
                      so the trigger reads as a reversible action; the actual
                      "yes, disconnect" confirmation inside the dialog keeps
                      its solid-red treatment. */}
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-destructive"
                  >
                    <Unlink className="mr-2 h-4 w-4" />
                    {t("settings.moodLogDisconnect")}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      {t("settings.moodLogDisconnectTitle")}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {t("settings.moodLogDisconnectDescription")}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                    <AlertDialogAction onClick={handleDisconnect}>
                      {t("settings.moodLogDisconnect")}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </div>
        )}

        {msg && (
          <p
            role="alert"
            className={`text-sm ${msgType === "error" ? "text-destructive" : "text-dracula-green"}`}
          >
            {msg}
          </p>
        )}
      </div>
    </div>
  );
}
