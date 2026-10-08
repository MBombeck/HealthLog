"use client";

/**
 * `<McpSection>` — Settings → MCP connector. v1.22.0.
 *
 * One card co-locating the two things a self-hoster needs to connect an external
 * assistant (Claude.ai / ChatGPT) to their own data over the remote MCP
 * endpoint:
 *
 *   1. the off-by-default `mcp` module toggle (the opt-in switch that turns the
 *      `/mcp` surface on for this account — it answers 404 until then), and
 *   2. a dedicated `health:read`-scoped token (mint shown once, copy, list with
 *      last-used, revoke). This is the manual / stdio path; cloud connectors get
 *      the same scope automatically through the OAuth flow.
 *
 * The minted token is NEVER `medication:ingest` and NEVER `["*"]` — it is the
 * least-privilege read scope and nothing more.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Key, Link2, Loader2, Plug, Trash2 } from "lucide-react";
import { toast } from "sonner";

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
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { useAuth } from "@/hooks/use-auth";
import { formatDate, formatDateTime } from "@/lib/format";
import { useTranslations } from "@/lib/i18n/context";
import {
  aiInputDependentKeys,
  invalidateKeys,
  queryKeys,
} from "@/lib/query-keys";
import { apiFetchRaw, apiGet, apiPatch } from "@/lib/api/api-fetch";
import {
  recentProofErrorMessage,
  throwIfReproofRequired,
  useRecentProof,
} from "@/components/settings/security-section/use-recent-proof";

interface McpTokenInfo {
  id: string;
  name: string;
  permissions: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  revoked: boolean;
}

interface McpConnectionInfo {
  id: string;
  clientName: string;
  scope: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export function McpSection() {
  return (
    <div className="space-y-6">
      <McpEnableCard />
      <McpConnectionsCard />
      <McpTokensCard />
    </div>
  );
}

function McpConnectionsCard() {
  const { t } = useTranslations();
  const { isAuthenticated } = useAuth();
  const queryClient = useQueryClient();

  const {
    data: connections,
    isError,
    isLoading,
    refetch,
  } = useQuery({
    queryKey: queryKeys.mcpConnections(),
    queryFn: async () => apiGet<McpConnectionInfo[]>("/api/mcp/connections"),
    enabled: isAuthenticated,
  });

  async function handleRevoke(connectionId: string) {
    try {
      const res = await apiFetchRaw(`/api/mcp/connections/${connectionId}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        toast.error(t("settings.mcp.connectionRevokeFailed"));
        return;
      }
      queryClient.invalidateQueries({ queryKey: queryKeys.mcpConnections() });
    } catch {
      toast.error(t("settings.mcp.connectionRevokeFailed"));
    }
  }

  const list = connections ?? [];

  return (
    <SettingsCard>
      <SettingsCardHeader
        icon={Link2}
        title={t("settings.mcp.connectionsTitle")}
        description={t("settings.mcp.connectionsDescription")}
      />
      <p className="text-sm">{t("settings.mcp.connectionsDetail")}</p>

      <div className="space-y-4">
        {isError ? (
          <QueryErrorCard onRetry={() => refetch()} />
        ) : isLoading ? (
          <Skeleton className="h-24 w-full rounded-lg" />
        ) : list.length === 0 ? (
          <EmptyState size="compact" title={t("settings.mcp.noConnections")} />
        ) : (
          <ul className="space-y-2">
            {list.map((conn) => (
              <li
                key={conn.id}
                className="bg-muted/30 border-border space-y-2 rounded-lg border p-3"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="min-w-0 flex-1 text-sm font-medium break-all">
                    {conn.clientName}
                  </p>
                  <Badge className="bg-success/15 text-success text-xs">
                    {t("settings.mcp.connectionConnected")}
                  </Badge>
                </div>
                <p className="text-muted-foreground text-xs">
                  <span className="font-medium">
                    {t("settings.tokenTablePermissions")}:
                  </span>{" "}
                  {conn.scope}
                </p>
                <p className="text-muted-foreground text-xs">
                  <span className="font-medium">
                    {t("settings.mcp.connectionLastUsed")}:
                  </span>{" "}
                  {conn.lastUsedAt
                    ? formatDateTime(conn.lastUsedAt)
                    : t("settings.mcp.connectionNeverUsed")}
                </p>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      className="min-h-11 w-full"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      {t("settings.mcp.connectionRevoke")}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>
                        {t("settings.mcp.connectionRevoke")}
                      </AlertDialogTitle>
                      <AlertDialogDescription>
                        {t("settings.mcp.connectionRevokeDescription")}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>
                        {t("common.cancel")}
                      </AlertDialogCancel>
                      <AlertDialogAction
                        variant="destructive"
                        onClick={() => handleRevoke(conn.id)}
                      >
                        {t("settings.mcp.connectionRevoke")}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </li>
            ))}
          </ul>
        )}
      </div>
    </SettingsCard>
  );
}

function McpEnableCard() {
  const { t } = useTranslations();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  // The opt-in module is OFF until explicitly enabled — `user.modules.mcp` is
  // the resolved state (true only when the user turned it on).
  const enabled = user?.modules?.mcp === true;
  const endpoint =
    typeof window !== "undefined" ? `${window.location.origin}/mcp` : "/mcp";

  const toggle = useMutation({
    mutationKey: queryKeys.modulesPrefs(),
    mutationFn: async (next: boolean) =>
      apiPatch("/api/auth/me/modules", { mcp: next }),
    onSuccess: () => {
      void invalidateKeys(queryClient, aiInputDependentKeys);
      toast.success(t("settings.sections.modules.saved"));
    },
    onError: () => toast.error(t("settings.sections.modules.error")),
  });

  return (
    <SettingsCard>
      <SettingsCardHeader
        icon={Plug}
        title={t("settings.mcp.enableTitle")}
        description={t("settings.mcp.enableDescription")}
      />

      <div className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <span className="text-sm font-medium">
            {t("settings.mcp.enableToggleLabel")}
          </span>
          <Switch
            checked={enabled}
            disabled={toggle.isPending}
            onCheckedChange={(next) => toggle.mutate(next)}
            aria-label={t("settings.mcp.enableToggleLabel")}
          />
        </div>

        <div>
          <p className="text-muted-foreground mb-1 text-xs tracking-wide uppercase">
            {t("settings.mcp.endpointLabel")}
          </p>
          <code className="bg-muted block rounded p-2 font-mono text-xs break-all">
            {endpoint}
          </code>
          <p className="text-muted-foreground mt-2 text-xs leading-relaxed">
            {t("settings.mcp.connectDescription")}
          </p>
        </div>
      </div>
    </SettingsCard>
  );
}

function McpTokensCard() {
  const { t } = useTranslations();
  const { isAuthenticated } = useAuth();
  const queryClient = useQueryClient();
  const [newName, setNewName] = useState("");
  const [allowWrite, setAllowWrite] = useState(false);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [tokenMsg, setTokenMsg] = useState<string | null>(null);
  const [tokenCopied, setTokenCopied] = useState(false);

  const {
    data: tokens,
    isError,
    isLoading,
    refetch,
  } = useQuery({
    queryKey: queryKeys.mcpTokens(),
    queryFn: async () => apiGet<McpTokenInfo[]>("/api/mcp/tokens"),
    enabled: isAuthenticated,
  });

  // A connector token outlives the session, so minting one asks for a fresh
  // proof unless the session signed in or re-proved within five minutes.
  const recentProof = useRecentProof();

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setTokenMsg(null);
    setNewToken(null);
    try {
      const body = JSON.stringify({
        name: newName.trim(),
        // Closed choice — read-only, or read + the audience-bound write scope.
        scope: allowWrite ? "read_write" : "read",
      });
      const res = await recentProof.run(async () =>
        throwIfReproofRequired(
          await apiFetchRaw("/api/mcp/tokens", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
          }),
        ),
      );
      const json = await res.json();
      if (res.ok) {
        setNewToken(json.data.token);
        setNewName("");
        setAllowWrite(false);
        queryClient.invalidateQueries({ queryKey: queryKeys.mcpTokens() });
      } else {
        setTokenMsg(json.error || t("common.error"));
      }
    } catch (err) {
      setTokenMsg(recentProofErrorMessage(err, t("common.networkError")));
    } finally {
      setCreating(false);
    }
  }

  async function handleCopyToken() {
    if (!newToken) return;
    try {
      await navigator.clipboard.writeText(newToken);
      setTokenCopied(true);
      toast.success(t("settings.tokenCopied"));
      setTimeout(() => setTokenCopied(false), 2_000);
    } catch {
      toast.error(t("settings.tokenCopyFailed"));
    }
  }

  async function handleRevoke(tokenId: string) {
    try {
      const res = await apiFetchRaw(`/api/mcp/tokens/${tokenId}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        toast.error(t("settings.tokenRevokeFailed"));
        return;
      }
      queryClient.invalidateQueries({ queryKey: queryKeys.mcpTokens() });
    } catch {
      toast.error(t("settings.tokenRevokeFailed"));
    }
  }

  const activeTokens = (tokens ?? []).filter((tok) => !tok.revoked);

  return (
    <SettingsCard>
      {recentProof.dialog}
      <SettingsCardHeader
        icon={Key}
        title={t("settings.mcp.tokensTitle")}
        description={t("settings.mcp.tokensDescription")}
      />
      <div className="space-y-4">
        {/* "Shown once" is part of the same statement as the scope note, so
            it reads inside that paragraph rather than as a line of its own. */}
        <p className="text-sm leading-relaxed">
          {t("settings.mcp.tokensDetail")} {t("settings.mcp.scopeNote")}
        </p>

        <div className="border-border bg-muted/30 space-y-2 rounded-lg border p-3">
          <div className="flex items-center justify-between gap-4">
            <span className="text-sm font-medium">
              {t("settings.mcp.writeScopeToggleLabel")}
            </span>
            <Switch
              checked={allowWrite}
              onCheckedChange={setAllowWrite}
              aria-label={t("settings.mcp.writeScopeToggleLabel")}
            />
          </div>
          <p className="text-sm leading-relaxed">
            {t("settings.mcp.writeScopeNote")}
          </p>
        </div>

        <form onSubmit={handleCreate} className="flex items-center gap-2">
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder={t("settings.mcp.tokenNamePlaceholder")}
            aria-label={t("settings.tokenNameLabel")}
            maxLength={100}
            className="flex-1"
          />
          <Button
            type="submit"
            variant="outline"
            className="h-11 sm:h-10"
            disabled={creating || !newName.trim()}
          >
            {creating && (
              <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
            )}
            {t("common.create")}
          </Button>
        </form>

        {newToken && (
          <div
            className="bg-success/10 rounded-lg p-3 text-sm"
            data-slot="settings-mcp-token-created"
          >
            <p className="text-success mb-1 font-medium">
              {t("settings.tokenCreated")}
            </p>
            <div className="flex items-start gap-2">
              <code className="bg-muted block flex-1 rounded p-2 font-mono text-xs break-all">
                {newToken}
              </code>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="min-h-11 min-w-11 shrink-0 sm:h-9 sm:w-9"
                onClick={() => void handleCopyToken()}
                aria-label={t("settings.tokenCopy")}
              >
                {tokenCopied ? (
                  <Check className="text-success h-3.5 w-3.5" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
              </Button>
            </div>
          </div>
        )}

        {tokenMsg && (
          <p role="alert" className="text-destructive text-sm">
            {tokenMsg}
          </p>
        )}

        <div>
          <p className="mb-2 text-sm font-medium">
            {t("settings.activeTokensTitle")}
          </p>
          {isError ? (
            <QueryErrorCard onRetry={() => refetch()} />
          ) : isLoading ? (
            <Skeleton className="h-24 w-full rounded-lg" />
          ) : activeTokens.length === 0 ? (
            <EmptyState size="compact" title={t("settings.noActiveTokens")} />
          ) : (
            <ul className="space-y-2">
              {activeTokens.map((tok) => {
                const isExpired =
                  tok.expiresAt && new Date(tok.expiresAt) < new Date();
                return (
                  <li
                    key={tok.id}
                    className="bg-muted/30 border-border space-y-2 rounded-lg border p-3"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <p className="min-w-0 flex-1 text-sm font-medium break-all">
                        {tok.name}
                      </p>
                      {isExpired ? (
                        <Badge variant="destructive" className="text-xs">
                          {t("settings.tokenExpired")}
                        </Badge>
                      ) : (
                        <Badge className="bg-success/15 text-success text-xs">
                          {t("settings.tokenActive")}
                        </Badge>
                      )}
                    </div>
                    <p className="text-muted-foreground text-xs">
                      <span className="font-medium">
                        {t("settings.tokenTablePermissions")}:
                      </span>{" "}
                      {tok.permissions.join(", ")}
                    </p>
                    <p className="text-muted-foreground text-xs">
                      <span className="font-medium">
                        {t("settings.tokenTableCreated")}:
                      </span>{" "}
                      {formatDate(tok.createdAt)}
                    </p>
                    <p className="text-muted-foreground text-xs">
                      <span className="font-medium">
                        {t("settings.tokenTableLastUsed")}:
                      </span>{" "}
                      {tok.lastUsedAt
                        ? formatDateTime(tok.lastUsedAt)
                        : t("settings.tokenNeverUsed")}
                    </p>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          variant="outline"
                          size="sm"
                          className="min-h-11 w-full"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          {t("settings.tokenRevoke")}
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>
                            {t("settings.tokenRevoke")}
                          </AlertDialogTitle>
                          <AlertDialogDescription>
                            {t("settings.tokenRevokeDescription")}
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>
                            {t("common.cancel")}
                          </AlertDialogCancel>
                          <AlertDialogAction
                            variant="destructive"
                            onClick={() => handleRevoke(tok.id)}
                          >
                            {t("settings.tokenRevoked")}
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </SettingsCard>
  );
}
