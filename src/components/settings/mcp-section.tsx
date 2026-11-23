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
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Key, Link2, Loader2, Plug, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { showErrorToast } from "@/lib/errors/error-toast";

import { ConfirmButton } from "@/components/ui/confirm-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { Skeleton } from "@/components/ui/skeleton";
import { SwitchRow } from "@/components/ui/switch-row";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { ModuleStateCard } from "@/components/settings/module-state-card";
import { useAuth } from "@/hooks/use-auth";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { apiFetchRaw, apiGet } from "@/lib/api/api-fetch";
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
  const fmt = useFormatters();
  const { isAuthenticated } = useAuth();
  const queryClient = useQueryClient();

  const {
    data: connections,
    isError,
    error,
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
        showErrorToast(t("settings.mcp.connectionRevokeFailed"), {
          cause: res,
        });
        return;
      }
      queryClient.invalidateQueries({ queryKey: queryKeys.mcpConnections() });
    } catch (failure) {
      showErrorToast(t("settings.mcp.connectionRevokeFailed"), {
        cause: failure,
      });
    }
  }

  const list = connections ?? [];

  return (
    <SettingsCard>
      <SettingsCardHeader
        anchor="mcp-connections"
        icon={Link2}
        title={t("settings.mcp.connectionsTitle")}
        description={t("settings.mcp.connectionsDescription")}
      />
      <p className="text-sm">{t("settings.mcp.connectionsDetail")}</p>

      <div className="space-y-4">
        {isError ? (
          <QueryErrorCard error={error} onRetry={() => refetch()} />
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
                  <p className="min-w-0 flex-1 text-sm font-medium break-words">
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
                    ? fmt.dateTime(conn.lastUsedAt)
                    : t("settings.mcp.connectionNeverUsed")}
                </p>
                <ConfirmButton
                  label={t("settings.mcp.connectionRevoke")}
                  className="min-h-11 w-full"
                  title={t("settings.mcp.connectionRevoke")}
                  body={t("settings.mcp.connectionRevokeDescription")}
                  confirmLabel={t("settings.mcp.connectionRevoke")}
                  onConfirm={() => void handleRevoke(conn.id)}
                  slot="mcp-connection-revoke"
                  icon={<Trash2 className="h-3.5 w-3.5" />}
                  destructive
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </SettingsCard>
  );
}

/**
 * The connector's state, with a link to the one switch in Settings > Modules.
 * Turning the module off pauses the endpoint: it refuses every call, while the
 * tokens and connections below stay as they are and work again once it is on.
 * Nothing here or in Modules revokes a token as a side effect (#1170); a token
 * goes only through its own revoke.
 */
function McpEnableCard() {
  const { t } = useTranslations();
  const { user } = useAuth();

  // The opt-in module is OFF until explicitly enabled — `user.modules.mcp` is
  // the resolved state (true only when the user turned it on).
  const enabled = user?.modules?.mcp === true;
  const endpoint =
    typeof window !== "undefined" ? `${window.location.origin}/mcp` : "/mcp";

  return (
    <ModuleStateCard
      moduleKey="mcp"
      enabled={enabled}
      icon={Plug}
      title={t("settings.mcp.enableTitle")}
      description={t("settings.mcp.enableDescription")}
      anchor="mcp-enable"
      slot="settings-mcp-state-card"
    >
      <p className="text-sm">{t("settings.mcp.offKeepsTokens")}</p>
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
    </ModuleStateCard>
  );
}

function McpTokensCard() {
  const [{ t }, fmt] = [useTranslations(), useFormatters()];
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
    error,
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
    } catch (failure) {
      showErrorToast(t("settings.tokenCopyFailed"), { cause: failure });
    }
  }

  async function handleRevoke(tokenId: string) {
    try {
      const res = await apiFetchRaw(`/api/mcp/tokens/${tokenId}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        showErrorToast(t("settings.tokenRevokeFailed"), { cause: res });
        return;
      }
      queryClient.invalidateQueries({ queryKey: queryKeys.mcpTokens() });
    } catch (failure) {
      showErrorToast(t("settings.tokenRevokeFailed"), { cause: failure });
    }
  }

  const activeTokens = (tokens ?? []).filter((tok) => !tok.revoked);

  return (
    <SettingsCard>
      {recentProof.dialog}
      <SettingsCardHeader
        anchor="mcp-tokens"
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
          <SwitchRow
            label={t("settings.mcp.writeScopeToggleLabel")}
            checked={allowWrite}
            onCheckedChange={setAllowWrite}
            aria-label={t("settings.mcp.writeScopeToggleLabel")}
          />
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
            <QueryErrorCard error={error} onRetry={() => refetch()} />
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
                      <p className="min-w-0 flex-1 text-sm font-medium break-words">
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
                      {fmt.date(tok.createdAt)}
                    </p>
                    <p className="text-muted-foreground text-xs">
                      <span className="font-medium">
                        {t("settings.tokenTableLastUsed")}:
                      </span>{" "}
                      {tok.lastUsedAt
                        ? fmt.dateTime(tok.lastUsedAt)
                        : t("settings.tokenNeverUsed")}
                    </p>
                    <ConfirmButton
                      label={t("settings.tokenRevokeAction")}
                      className="min-h-11 w-full"
                      title={t("settings.tokenRevoke")}
                      body={t("settings.tokenRevokeDescription")}
                      confirmLabel={t("settings.tokenRevokeAction")}
                      onConfirm={() => void handleRevoke(tok.id)}
                      slot="mcp-token-revoke"
                      icon={<Trash2 className="h-3.5 w-3.5" />}
                      destructive
                    />
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
