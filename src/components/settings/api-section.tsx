"use client";

/**
 * Settings → API & tokens: one table of tokens and one card with the API
 * address.
 *
 * Every token the account holds is a row: name, what it may do as one short
 * chip, when it was created, when it was last used, and a menu (Apple Health
 * write-back for a measurement token, revoke). "New token" in the page header
 * opens one flow for every kind this page mints (measurements, workouts,
 * documents): name, access, expiry, then the token, shown once. Medication
 * tokens are still minted on the medication they belong to, and MCP tokens on
 * the MCP page; both are listed and revoked here.
 */

import { useId, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Braces,
  ExternalLink,
  KeyRound,
  MoreHorizontal,
  Trash2,
} from "lucide-react";

import {
  NEW_TOKEN_PARAM,
  openNewToken,
} from "@/components/settings/api-new-token-button";
import {
  CopyValueButton,
  NewTokenSheet,
} from "@/components/settings/api-new-token-sheet";
import {
  UnattributedReadingsNotice,
  isMeasurementTokenInfo,
  patchTokenMirror,
} from "@/components/settings/apple-health-mirror-token";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { SettingsCard } from "@/components/settings/settings-card";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { InlineAction } from "@/components/ui/inline-action";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { Skeleton } from "@/components/ui/skeleton";
import { TagChip } from "@/components/ui/tag-chip";
import { useAuth } from "@/hooks/use-auth";
import { apiFetchRaw, apiGet } from "@/lib/api/api-fetch";
import { showErrorToast } from "@/lib/errors/error-toast";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { useUrlSearch } from "@/lib/url-state";
import { cn } from "@/lib/utils";
import { formatHealthInstant } from "@/components/settings/integrations/integration-health-copy";

interface ApiTokenInfo {
  id: string;
  name: string;
  permissions: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  revoked: boolean;
  mirrorToAppleHealth: boolean;
}

/** The public API reference. */
const API_REFERENCE_URL = "https://docs.healthlog.dev/reference/api-endpoints/";

/**
 * One short word per scope, in the order a token's chip prefers them: a
 * token carrying several scopes shows the first that matches.
 */
const SCOPE_LABEL_KEY: ReadonlyArray<readonly [string, string]> = [
  ["*", "settings.tokenList.scope.all"],
  ["measurements:write", "settings.tokenList.scope.measurements"],
  ["workouts:write", "settings.tokenList.scope.workouts"],
  ["documents:write", "settings.tokenList.scope.documents"],
  ["medication:ingest", "settings.tokenList.scope.medication"],
  ["health:write", "settings.tokenList.scope.mcpWrite"],
  ["health:read", "settings.tokenList.scope.mcpRead"],
  ["fhir:read", "settings.tokenList.scope.fhir"],
  ["profile:read", "settings.tokenList.scope.profile"],
];

function scopeLabel(
  permissions: readonly string[],
  t: (key: string) => string,
): string {
  for (const [scope, key] of SCOPE_LABEL_KEY) {
    if (permissions.includes(scope)) return t(key);
  }
  return permissions.join(", ");
}

export function ApiSection() {
  const search = useUrlSearch();
  return (
    <div className="space-y-6">
      <TokensCard />
      <ApiAddressCard />
      <NewTokenSheet
        open={search.get(NEW_TOKEN_PARAM) === "1"}
        onOpenChange={(open) => openNewToken(open)}
      />
    </div>
  );
}

function TokensCard() {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const { isAuthenticated } = useAuth();
  const [showRevoked, setShowRevoked] = useState(false);
  const captionId = useId();

  const {
    data: tokens,
    isError,
    error,
    isLoading,
    refetch,
  } = useQuery({
    queryKey: queryKeys.tokens(),
    queryFn: () => apiGet<ApiTokenInfo[]>("/api/tokens"),
    enabled: isAuthenticated,
  });

  const active = (tokens ?? []).filter((tok) => !tok.revoked);
  const revoked = (tokens ?? []).filter((tok) => tok.revoked);
  const rows = showRevoked ? [...active, ...revoked] : active;

  const lastUsed = (tok: ApiTokenInfo) => {
    if (tok.revoked) return t("settings.tokenList.revoked");
    if (tok.expiresAt && new Date(tok.expiresAt) < new Date()) {
      return t("settings.tokenExpired");
    }
    return tok.lastUsedAt
      ? formatHealthInstant(tok.lastUsedAt, t, fmt)
      : t("settings.tokenNeverUsed");
  };

  return (
    <SettingsCard flush data-slot="api-tokens-card">
      <SettingsCardHeader
        anchor="api-tokens"
        icon={KeyRound}
        title={t("settings.tokenList.title")}
        className="px-4 py-4 md:px-6"
      />
      {isError ? (
        <div className="border-t px-4 py-4 md:px-6">
          <QueryErrorCard error={error} onRetry={() => void refetch()} />
        </div>
      ) : isLoading ? (
        <div
          className="border-t px-4 py-4 md:px-6"
          data-testid="settings-api-tokens-loading"
        >
          <Skeleton className="h-24 w-full" />
        </div>
      ) : rows.length === 0 && revoked.length === 0 ? (
        <div className="border-t px-4 py-4 md:px-6">
          <EmptyState
            variant="plain"
            title={t("settings.tokenList.empty")}
            data-testid="settings-api-tokens-active-empty"
            action={
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-h-11 sm:min-h-9"
                onClick={() => openNewToken(true)}
              >
                {t("settings.tokenList.newToken")}
              </Button>
            }
          />
        </div>
      ) : (
        <div
          className="border-t"
          role="region"
          aria-labelledby={captionId}
          data-testid="settings-api-tokens-table"
        >
          <table className="w-full text-sm md:table-fixed">
            <caption id={captionId} className="sr-only">
              {t("settings.tokenList.caption")}
            </caption>
            <thead className="max-md:sr-only">
              <tr className="text-muted-foreground border-b text-xs">
                <th
                  scope="col"
                  className="px-4 py-2 text-left font-medium md:pl-6"
                >
                  {t("settings.tokenTableName")}
                </th>
                <th
                  scope="col"
                  className="w-28 px-2 py-2 text-left font-medium md:w-36"
                >
                  {t("settings.tokenList.scopeColumn")}
                </th>
                <th
                  scope="col"
                  className="hidden w-36 px-2 py-2 text-left font-medium md:table-cell"
                >
                  {t("settings.tokenTableCreated")}
                </th>
                <th
                  scope="col"
                  className="hidden w-44 px-2 py-2 text-left font-medium md:table-cell"
                >
                  {t("settings.tokenTableLastUsed")}
                </th>
                <th scope="col" className="w-14 py-2 pr-4 md:pr-6">
                  <span className="sr-only">
                    {t("settings.tokenTableActions")}
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((tok) => (
                <tr
                  key={tok.id}
                  className={cn(
                    "border-b last:border-b-0",
                    tok.revoked && "opacity-60",
                  )}
                  aria-disabled={tok.revoked || undefined}
                  data-testid="settings-api-token-row"
                >
                  <th
                    scope="row"
                    className="w-full max-w-0 px-4 py-3 text-left font-medium md:w-auto md:max-w-none md:pl-6"
                  >
                    <span className="block truncate">{tok.name}</span>
                    {/* On a phone the two date columns fold into one meta line. */}
                    <span className="text-muted-foreground block truncate font-normal md:hidden">
                      {lastUsed(tok)}
                    </span>
                  </th>
                  <td className="px-2 py-3 whitespace-nowrap">
                    <TagChip>{scopeLabel(tok.permissions, t)}</TagChip>
                  </td>
                  <td className="text-muted-foreground hidden px-2 py-3 md:table-cell">
                    {fmt.date(tok.createdAt)}
                  </td>
                  <td className="text-muted-foreground hidden truncate px-2 py-3 md:table-cell">
                    {lastUsed(tok)}
                  </td>
                  <td className="pr-2 text-right md:pr-4">
                    {tok.revoked ? null : <TokenMenu token={tok} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {revoked.length > 0 ? (
            <div className="border-t px-4 py-2 md:px-6">
              <InlineAction
                tone="muted"
                size="sm"
                aria-expanded={showRevoked}
                onClick={() => setShowRevoked((open) => !open)}
                data-testid="settings-api-tokens-show-revoked"
              >
                {showRevoked
                  ? t("settings.tokenList.hideRevoked")
                  : t("settings.revokedTokensTitle", { count: revoked.length })}
              </InlineAction>
            </div>
          ) : null}
        </div>
      )}
      <UnattributedReadingsNotice className="border-t px-4 py-3 md:px-6" />
    </SettingsCard>
  );
}

/** A row's menu: the Apple Health write-back (measurement tokens) and revoke. */
function TokenMenu({ token }: { token: ApiTokenInfo }) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [savingMirror, setSavingMirror] = useState(false);
  const measurement = isMeasurementTokenInfo(token.permissions);

  async function revoke() {
    try {
      const res = await apiFetchRaw(`/api/tokens/${token.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        showErrorToast(t("settings.tokenRevokeFailed"), { cause: res });
        return;
      }
      await queryClient.invalidateQueries({ queryKey: queryKeys.tokens() });
    } catch (failure) {
      showErrorToast(t("settings.tokenRevokeFailed"), { cause: failure });
    }
  }

  async function setMirror(next: boolean) {
    setSavingMirror(true);
    try {
      await patchTokenMirror(token.id, next);
      await queryClient.invalidateQueries({ queryKey: queryKeys.tokens() });
    } catch (failure) {
      showErrorToast(t("settings.measurementsToken.appleHealth.updateFailed"), {
        cause: failure,
      });
    } finally {
      setSavingMirror(false);
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="min-h-11 min-w-11 sm:size-9 sm:min-h-9 sm:min-w-9"
            aria-label={t("settings.tokenList.menuLabel", { name: token.name })}
            data-testid="settings-api-token-menu"
          >
            <MoreHorizontal className="size-4" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="w-64 max-w-[calc(100vw-2rem)]"
        >
          {measurement ? (
            <DropdownMenuCheckboxItem
              checked={token.mirrorToAppleHealth}
              disabled={savingMirror}
              onCheckedChange={(next) => void setMirror(next === true)}
              data-slot="apple-health-mirror-switch"
            >
              {t("settings.measurementsToken.appleHealth.label")}
            </DropdownMenuCheckboxItem>
          ) : null}
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => setConfirming(true)}
            data-testid="settings-api-token-revoke"
          >
            <Trash2 aria-hidden="true" />
            {t("settings.tokenRevokeAction")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {confirming ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setConfirming(false);
          }}
          title={t("settings.tokenRevoke")}
          body={t("settings.tokenRevokeDescription")}
          confirmLabel={t("settings.tokenRevokeAction")}
          destructive
          slot="settings-api-token-revoke"
          onConfirm={() => {
            setConfirming(false);
            void revoke();
          }}
        />
      ) : null}
    </>
  );
}

function ApiAddressCard() {
  const { t } = useTranslations();
  const [origin] = useState(() =>
    typeof window === "undefined" ? "" : window.location.origin,
  );
  const address = `${origin}/api`;
  return (
    <SettingsCard flush data-slot="api-address-card">
      <SettingsCardHeader
        anchor="api-address"
        icon={Braces}
        title={t("settings.tokenList.api.title")}
        className="px-4 py-4 md:px-6"
      />
      <div className="flex min-h-14 items-center gap-3 border-t px-4 py-2 md:px-6">
        <span className="shrink-0 text-sm font-medium">
          {t("settings.tokenList.api.address")}
        </span>
        <code
          className="text-muted-foreground min-w-0 flex-1 truncate text-right font-mono text-sm"
          data-testid="api-address"
        >
          {address}
        </code>
        <CopyValueButton
          value={address}
          label={t("settings.tokenList.api.copyAddress")}
          testId="api-address-copy"
        />
      </div>
      <div className="flex min-h-14 items-center gap-3 border-t px-4 py-2 md:px-6">
        <span className="min-w-0 flex-1 text-sm font-medium">
          {t("settings.tokenList.api.endpoints")}
        </span>
        <Button
          asChild
          variant="outline"
          size="sm"
          className="min-h-11 sm:min-h-9"
        >
          <a href={API_REFERENCE_URL} target="_blank" rel="noopener noreferrer">
            {t("settings.tokenList.api.openReference")}
            <ExternalLink className="size-3.5" aria-hidden="true" />
          </a>
        </Button>
      </div>
    </SettingsCard>
  );
}
