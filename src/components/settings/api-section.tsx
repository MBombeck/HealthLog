"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Key, Loader2, Trash2 } from "lucide-react";

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
import { useAuth } from "@/hooks/use-auth";
import { formatDate, formatDateTime } from "@/lib/format";
import { useTranslations } from "@/lib/i18n/context";

interface ApiTokenInfo {
  id: string;
  name: string;
  permissions: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  revoked: boolean;
}

export function ApiSection() {
  const { t } = useTranslations();

  return (
    <section aria-labelledby="settings-section-api-title" className="space-y-6">
      <header className="space-y-1">
        <h1
          id="settings-section-api-title"
          className="text-2xl font-semibold tracking-tight"
        >
          {t("settings.sections.api.title")}
        </h1>
        <p className="text-muted-foreground text-sm">
          {t("settings.sections.api.description")}
        </p>
      </header>

      <ApiEndpointsCard />
      <ApiTokensCard />
    </section>
  );
}

function ApiEndpointsCard() {
  const { t } = useTranslations();

  // v1.4.27 MB5 — dual-render: <md gets a stacked card list, md+
  // keeps the original table. Mobile cards wrap inside their box and
  // never trigger horizontal scroll, mirroring the pattern from
  // `<ApiTokenOverviewSection>`. The endpoint catalogue currently
  // ships a single row but stays array-driven so adding new rows
  // remains a one-line edit on both surfaces.
  const endpoints = [
    {
      method: "POST",
      path: "/api/ingest/medication",
      auth: "Authorization: Bearer hlk_...",
      example: `{ "medicationName": "...", "scheduledFor": "..." }`,
    },
  ];

  return (
    <div className="bg-card border-border rounded-xl border p-6">
      <div className="flex items-center gap-2">
        <Key className="text-primary h-5 w-5" />
        <h2 className="text-lg font-semibold">
          {t("settings.apiEndpointsTitle")}
        </h2>
      </div>
      <p className="text-muted-foreground mt-1 text-xs">
        {t("settings.apiEndpointsDescription")}
      </p>

      {/* Desktop table — verbatim layout for md+. */}
      <div className="border-border mt-4 hidden overflow-x-auto rounded-lg border md:block">
        <table className="w-full min-w-[760px] text-xs md:min-w-0">
          <thead>
            <tr className="bg-muted/40 text-muted-foreground border-b">
              <th className="px-3 py-2 text-left font-medium">
                {t("settings.apiEndpointMethod")}
              </th>
              <th className="px-3 py-2 text-left font-medium">
                {t("settings.apiEndpointPath")}
              </th>
              <th className="px-3 py-2 text-left font-medium">
                {t("settings.apiEndpointAuth")}
              </th>
              <th className="px-3 py-2 text-left font-medium">
                {t("settings.apiEndpointExample")}
              </th>
            </tr>
          </thead>
          <tbody>
            {endpoints.map((endpoint) => (
              <tr key={`${endpoint.method} ${endpoint.path}`}>
                <td className="px-3 py-2 font-medium">{endpoint.method}</td>
                <td className="px-3 py-2 font-mono">{endpoint.path}</td>
                <td className="px-3 py-2 font-mono">{endpoint.auth}</td>
                <td className="px-3 py-2 font-mono">{endpoint.example}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile card list — each endpoint stacks its columns vertically
          with a labelled meta row. No horizontal scroll. */}
      <ul
        className="mt-4 space-y-2 md:hidden"
        data-testid="settings-api-endpoints-mobile-list"
      >
        {endpoints.map((endpoint) => (
          <li
            key={`${endpoint.method} ${endpoint.path}`}
            className="bg-muted/30 border-border space-y-1.5 rounded-lg border p-3 text-xs"
          >
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary" className="text-[10px]">
                {endpoint.method}
              </Badge>
              <code className="font-mono break-all">{endpoint.path}</code>
            </div>
            <div>
              <p className="text-muted-foreground text-[10px] uppercase tracking-wide">
                {t("settings.apiEndpointAuth")}
              </p>
              <code className="font-mono break-all">{endpoint.auth}</code>
            </div>
            <div>
              <p className="text-muted-foreground text-[10px] uppercase tracking-wide">
                {t("settings.apiEndpointExample")}
              </p>
              <code className="block font-mono break-all">
                {endpoint.example}
              </code>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ApiTokensCard() {
  const { t } = useTranslations();
  const { isAuthenticated } = useAuth();
  const queryClient = useQueryClient();
  const [newName, setNewName] = useState("");
  const [newToken, setNewToken] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [tokenMsg, setTokenMsg] = useState<string | null>(null);
  const [showRevokedTokens, setShowRevokedTokens] = useState(false);

  const { data: tokens } = useQuery({
    queryKey: ["tokens"],
    queryFn: async () => {
      const res = await fetch("/api/tokens");
      if (!res.ok) throw new Error("Failed");
      return (await res.json()).data as ApiTokenInfo[];
    },
    enabled: isAuthenticated,
  });

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setTokenMsg(null);
    setNewToken(null);

    try {
      const res = await fetch("/api/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName.trim() }),
      });
      const json = await res.json();
      if (res.ok) {
        setNewToken(json.data.token);
        setNewName("");
        queryClient.invalidateQueries({ queryKey: ["tokens"] });
      } else {
        setTokenMsg(json.error || t("common.error"));
      }
    } catch {
      setTokenMsg(t("common.networkError"));
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke(tokenId: string) {
    const res = await fetch(`/api/tokens/${tokenId}`, { method: "DELETE" });
    if (res.ok) {
      queryClient.invalidateQueries({ queryKey: ["tokens"] });
    }
  }

  const activeTokens = (tokens ?? []).filter((tok) => !tok.revoked);
  const revokedTokens = (tokens ?? []).filter((tok) => tok.revoked);
  const latestActiveUse = activeTokens.reduce<string | null>((latest, tok) => {
    if (!tok.lastUsedAt) return latest;
    if (!latest || new Date(tok.lastUsedAt) > new Date(latest)) {
      return tok.lastUsedAt;
    }
    return latest;
  }, null);

  return (
    <div className="bg-card border-border rounded-xl border p-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <Key className="text-primary h-5 w-5" />
          <h2 className="text-lg font-semibold">{t("settings.apiTokens")}</h2>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {activeTokens.length > 0 && (
            <Badge className="border-dracula-green/30 bg-dracula-green/15 text-dracula-green">
              {t("settings.configured")}
            </Badge>
          )}
          {latestActiveUse && (
            <Badge variant="outline" className="text-xs">
              {t("settings.tokenTableLastUsed")}:{" "}
              {formatDateTime(latestActiveUse)}
            </Badge>
          )}
        </div>
      </div>
      <p className="text-muted-foreground mt-1 text-xs">
        {t("settings.apiTokensDescription")}
      </p>

      <div className="mt-4 space-y-4">
        <form onSubmit={handleCreate} className="flex gap-2">
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder={t("settings.tokenNamePlaceholder")}
            maxLength={100}
            className="flex-1"
          />
          <Button
            type="submit"
            variant="outline"
            size="sm"
            disabled={creating || !newName.trim()}
          >
            {creating && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />}
            {t("common.create")}
          </Button>
        </form>

        {newToken && (
          <div className="bg-dracula-green/10 rounded-lg p-3 text-sm">
            <p className="text-dracula-green mb-1 font-medium">
              {t("settings.tokenCreated")}
            </p>
            <code className="bg-muted block rounded p-2 font-mono text-xs break-all">
              {newToken}
            </code>
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
          {/* Desktop table — verbatim layout for md+, hidden on phones. */}
          <div className="border-border hidden overflow-x-auto rounded-lg border md:block">
            <table className="w-full min-w-[860px] text-sm md:min-w-0">
              <thead>
                <tr className="bg-muted/40 text-muted-foreground border-b text-xs">
                  <th className="px-3 py-2 text-left font-medium">
                    {t("settings.tokenTableName")}
                  </th>
                  <th className="px-3 py-2 text-left font-medium">
                    {t("settings.tokenTablePermissions")}
                  </th>
                  <th className="px-3 py-2 text-left font-medium">
                    {t("settings.tokenTableStatus")}
                  </th>
                  <th className="px-3 py-2 text-left font-medium">
                    {t("settings.tokenTableCreated")}
                  </th>
                  <th className="px-3 py-2 text-left font-medium">
                    {t("settings.tokenTableLastUsed")}
                  </th>
                  <th className="px-3 py-2 text-right font-medium">
                    {t("settings.tokenTableActions")}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-border divide-y">
                {activeTokens.length === 0 && (
                  <tr>
                    <td
                      colSpan={6}
                      className="text-muted-foreground px-3 py-4 text-center text-sm"
                    >
                      {t("settings.noActiveTokens")}
                    </td>
                  </tr>
                )}
                {activeTokens.map((tok, index) => {
                  const isExpired =
                    tok.expiresAt && new Date(tok.expiresAt) < new Date();
                  return (
                    <tr
                      key={tok.id}
                      className={index % 2 === 0 ? "bg-muted/20" : ""}
                    >
                      <td className="px-3 py-2 font-medium">{tok.name}</td>
                      <td className="text-muted-foreground px-3 py-2 text-xs">
                        {tok.permissions.join(", ")}
                      </td>
                      <td className="px-3 py-2">
                        {isExpired ? (
                          <Badge variant="destructive" className="text-xs">
                            {t("settings.tokenExpired")}
                          </Badge>
                        ) : (
                          <Badge className="bg-dracula-green/15 text-dracula-green text-xs">
                            {t("settings.tokenActive")}
                          </Badge>
                        )}
                      </td>
                      <td className="text-muted-foreground px-3 py-2 text-xs whitespace-nowrap">
                        {formatDate(tok.createdAt)}
                      </td>
                      <td className="text-muted-foreground px-3 py-2 text-xs whitespace-nowrap">
                        {tok.lastUsedAt
                          ? formatDateTime(tok.lastUsedAt)
                          : t("settings.tokenNeverUsed")}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="text-destructive h-8 w-8"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
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
                                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                onClick={() => handleRevoke(tok.id)}
                              >
                                {t("settings.tokenRevoked")}
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile card list — each row stacks its columns vertically
              with explicit labels so the data is readable inside a
              narrow viewport. The revoke action stays full-width to
              clear the 44pt tap-target floor. */}
          {activeTokens.length === 0 ? (
            <p
              className="text-muted-foreground rounded-lg border border-dashed px-3 py-4 text-center text-sm md:hidden"
              data-testid="settings-api-tokens-active-empty"
            >
              {t("settings.noActiveTokens")}
            </p>
          ) : (
            <ul
              className="space-y-2 md:hidden"
              data-testid="settings-api-tokens-mobile-list"
            >
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
                        <Badge variant="destructive" className="text-[10px]">
                          {t("settings.tokenExpired")}
                        </Badge>
                      ) : (
                        <Badge className="bg-dracula-green/15 text-dracula-green text-[10px]">
                          {t("settings.tokenActive")}
                        </Badge>
                      )}
                    </div>
                    <p className="text-muted-foreground text-[11px]">
                      <span className="font-medium">
                        {t("settings.tokenTablePermissions")}:
                      </span>{" "}
                      {tok.permissions.join(", ")}
                    </p>
                    <p className="text-muted-foreground text-[11px]">
                      <span className="font-medium">
                        {t("settings.tokenTableCreated")}:
                      </span>{" "}
                      {formatDate(tok.createdAt)}
                    </p>
                    <p className="text-muted-foreground text-[11px]">
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
                          className="text-destructive border-destructive/30 min-h-11 w-full"
                        >
                          <Trash2 className="mr-2 h-3.5 w-3.5" />
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
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
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

        {revokedTokens.length > 0 && (
          <div className="space-y-2">
            <button
              type="button"
              onClick={() => setShowRevokedTokens((prev) => !prev)}
              className="text-foreground hover:text-primary flex items-center gap-1 text-sm font-medium transition-colors"
            >
              <ChevronDown
                className={`h-4 w-4 transition-transform ${showRevokedTokens ? "rotate-180" : ""}`}
              />
              {t("settings.revokedTokensTitle", {
                count: revokedTokens.length,
              })}
            </button>
            {showRevokedTokens && (
              <>
                {/* Desktop table — verbatim layout for md+. */}
                <div className="border-border hidden overflow-x-auto rounded-lg border md:block">
                  <table className="w-full min-w-[760px] text-sm md:min-w-0">
                    <thead>
                      <tr className="bg-muted/40 text-muted-foreground border-b text-xs">
                        <th className="px-3 py-2 text-left font-medium">
                          {t("settings.tokenTableName")}
                        </th>
                        <th className="px-3 py-2 text-left font-medium">
                          {t("settings.tokenTablePermissions")}
                        </th>
                        <th className="px-3 py-2 text-left font-medium">
                          {t("settings.tokenTableCreated")}
                        </th>
                        <th className="px-3 py-2 text-left font-medium">
                          {t("settings.tokenTableLastUsed")}
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-border divide-y">
                      {revokedTokens.map((tok, index) => (
                        <tr
                          key={tok.id}
                          className={index % 2 === 0 ? "bg-muted/20" : ""}
                        >
                          <td className="px-3 py-2 font-medium">{tok.name}</td>
                          <td className="text-muted-foreground px-3 py-2 text-xs">
                            {tok.permissions.join(", ")}
                          </td>
                          <td className="text-muted-foreground px-3 py-2 text-xs whitespace-nowrap">
                            {formatDate(tok.createdAt)}
                          </td>
                          <td className="text-muted-foreground px-3 py-2 text-xs whitespace-nowrap">
                            {tok.lastUsedAt
                              ? formatDateTime(tok.lastUsedAt)
                              : t("settings.tokenNeverUsed")}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Mobile card list — stacked meta layout, no
                    horizontal scroll. Revoked tokens are read-only so
                    no action footer is needed. */}
                <ul
                  className="space-y-2 md:hidden"
                  data-testid="settings-api-tokens-revoked-mobile-list"
                >
                  {revokedTokens.map((tok) => (
                    <li
                      key={tok.id}
                      className="bg-muted/30 border-border space-y-1.5 rounded-lg border p-3"
                    >
                      <p className="text-sm font-medium break-all">
                        {tok.name}
                      </p>
                      <p className="text-muted-foreground text-[11px]">
                        <span className="font-medium">
                          {t("settings.tokenTablePermissions")}:
                        </span>{" "}
                        {tok.permissions.join(", ")}
                      </p>
                      <p className="text-muted-foreground text-[11px]">
                        <span className="font-medium">
                          {t("settings.tokenTableCreated")}:
                        </span>{" "}
                        {formatDate(tok.createdAt)}
                      </p>
                      <p className="text-muted-foreground text-[11px]">
                        <span className="font-medium">
                          {t("settings.tokenTableLastUsed")}:
                        </span>{" "}
                        {tok.lastUsedAt
                          ? formatDateTime(tok.lastUsedAt)
                          : t("settings.tokenNeverUsed")}
                      </p>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
