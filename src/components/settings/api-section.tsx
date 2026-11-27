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

import { useId, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Braces,
  Check,
  Copy,
  ExternalLink,
  KeyRound,
  Loader2,
  MoreHorizontal,
  Trash2,
} from "lucide-react";

import {
  NEW_TOKEN_PARAM,
  openNewToken,
} from "@/components/settings/api-new-token-button";
import {
  UnattributedReadingsNotice,
  isMeasurementTokenInfo,
  patchTokenMirror,
} from "@/components/settings/apple-health-mirror-token";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { SettingsCard } from "@/components/settings/settings-card";
import {
  recentProofErrorMessage,
  throwIfReproofRequired,
  useRecentProof,
} from "@/components/settings/security-section/use-recent-proof";
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
import { FieldGroup } from "@/components/ui/field-group";
import { InlineAction } from "@/components/ui/inline-action";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { SwitchRow } from "@/components/ui/switch-row";
import { TagChip } from "@/components/ui/tag-chip";
import { useAuth } from "@/hooks/use-auth";
import { apiFetchRaw, apiGet } from "@/lib/api/api-fetch";
import { showErrorToast } from "@/lib/errors/error-toast";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { useUrlSearch } from "@/lib/url-state";
import { cn } from "@/lib/utils";

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

/** What the "New token" flow mints, with the endpoint behind each. */
const MINT_KINDS = {
  measurements: {
    endpoint: "/api/tokens/measurements",
    labelKey: "settings.tokenList.scope.measurements",
    infoKey: "settings.tokenList.scopeInfo.measurements",
    placeholderKey: "settings.measurementsToken.namePlaceholder",
  },
  workouts: {
    endpoint: "/api/tokens/workouts",
    labelKey: "settings.tokenList.scope.workouts",
    infoKey: "settings.tokenList.scopeInfo.workouts",
    placeholderKey: "settings.workoutsToken.namePlaceholder",
  },
  documents: {
    endpoint: "/api/tokens/documents",
    labelKey: "settings.tokenList.scope.documents",
    infoKey: "settings.tokenList.scopeInfo.documents",
    placeholderKey: "settings.documentsToken.namePlaceholder",
  },
} as const;
type MintKind = keyof typeof MINT_KINDS;

/** Expiry choices in days; the routes accept 1 to 365. */
const EXPIRY_DAYS = [30, 90, 180, 365] as const;

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

/** "More": at most two sentences, opened on tap. */
function MoreInfo({ children, label }: { children: string; label: string }) {
  const { t } = useTranslations();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <InlineAction tone="muted" size="sm" aria-label={label}>
          {t("settings.tokenList.more")}
        </InlineAction>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} className="max-w-xs">
        <p className="text-sm">{children}</p>
      </PopoverContent>
    </Popover>
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
      ? fmt.dateTime(tok.lastUsedAt)
      : t("settings.tokenNeverUsed");
  };

  return (
    <SettingsCard flush data-slot="api-tokens-card">
      <div className="px-4 py-4 md:px-6">
        <SettingsCardHeader
          anchor="api-tokens"
          icon={KeyRound}
          title={t("settings.tokenList.title")}
        />
      </div>
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
            size="compact"
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
          <table className="w-full table-fixed text-sm">
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
                  className="w-36 px-2 py-2 text-left font-medium"
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
                    className="min-w-0 px-4 py-3 text-left font-medium md:pl-6"
                  >
                    <span className="block truncate">{tok.name}</span>
                    {/* On a phone the two date columns fold into one meta line. */}
                    <span className="text-muted-foreground block truncate font-normal md:hidden">
                      {lastUsed(tok)}
                    </span>
                  </th>
                  <td className="px-2 py-3">
                    <TagChip>{scopeLabel(tok.permissions, t)}</TagChip>
                  </td>
                  <td className="text-muted-foreground hidden px-2 py-3 md:table-cell">
                    {fmt.date(tok.createdAt)}
                  </td>
                  <td className="text-muted-foreground hidden truncate px-2 py-3 md:table-cell">
                    {lastUsed(tok)}
                  </td>
                  <td className="py-2 pr-2 text-right md:pr-4">
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
      <div className="px-4 empty:hidden md:px-6 [&>*]:mb-4">
        <UnattributedReadingsNotice />
      </div>
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

/** A copy button with its own announced outcome (`role="status"`). */
function CopyValueButton({
  value,
  label,
  testId,
}: {
  value: string;
  /** Names what is copied, for screen readers. */
  label: string;
  testId?: string;
}) {
  const { t } = useTranslations();
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<number | null>(null);

  async function copy() {
    if (timer.current !== null) window.clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      setState("failed");
    }
    timer.current = window.setTimeout(() => setState("idle"), 2000);
  }

  return (
    <span className="relative inline-flex shrink-0 items-center">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="min-h-11 sm:min-h-9"
        aria-label={label}
        onClick={() => void copy()}
        data-state={state}
        data-testid={testId}
      >
        {state === "copied" ? (
          <Check className="size-3.5" aria-hidden="true" />
        ) : (
          <Copy className="size-3.5" aria-hidden="true" />
        )}
        {state === "copied" ? t("settings.tokenList.copied") : t("common.copy")}
      </Button>
      <span role="status" className="sr-only">
        {state === "copied"
          ? t("settings.tokenList.copied")
          : state === "failed"
            ? t("settings.tokenCopyFailed")
            : ""}
      </span>
    </span>
  );
}

/** The API address once, with copy, and the reference. */
function ApiAddressCard() {
  const { t } = useTranslations();
  const [origin] = useState(() =>
    typeof window === "undefined" ? "" : window.location.origin,
  );
  const address = `${origin}/api`;
  return (
    <SettingsCard flush data-slot="api-address-card">
      <div className="px-4 py-4 md:px-6">
        <SettingsCardHeader
          anchor="api-address"
          icon={Braces}
          title={t("settings.tokenList.api.title")}
        />
      </div>
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

/** Name, access, expiry; then the token, shown once. */
function NewTokenSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const recentProof = useRecentProof();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<MintKind>("measurements");
  const [days, setDays] = useState<number>(365);
  const [mirror, setMirror] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const formId = useId();

  function reset() {
    setName("");
    setKind("measurements");
    setDays(365);
    setMirror(false);
    setError(null);
    setToken(null);
  }

  function close() {
    onOpenChange(false);
    reset();
  }

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setCreating(true);
    setError(null);
    try {
      const res = await recentProof.run(async () =>
        throwIfReproofRequired(
          await apiFetchRaw(MINT_KINDS[kind].endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: name.trim(),
              expiresInDays: days,
              ...(kind === "measurements" && { mirrorToAppleHealth: mirror }),
            }),
          }),
        ),
      );
      const json = await res.json();
      if (res.ok) {
        setToken(json.data.token);
        void queryClient.invalidateQueries({ queryKey: queryKeys.tokens() });
      } else {
        setError(json.error || t("settings.tokenList.create.failed"));
      }
    } catch (failure) {
      setError(recentProofErrorMessage(failure, t("common.networkError")));
    } finally {
      setCreating(false);
    }
  }

  const created = token !== null;

  return (
    <>
      {recentProof.dialog}
      <ResponsiveSheet
        open={open}
        onOpenChange={(next) => (next ? onOpenChange(true) : close())}
        title={
          created
            ? t("settings.tokenList.create.createdTitle")
            : t("settings.tokenList.newToken")
        }
        dirty={!created && name.trim().length > 0}
        footer={
          created ? (
            <Button
              type="button"
              size="sm"
              className="min-h-11 sm:min-h-9"
              onClick={close}
            >
              {t("settings.tokenList.create.done")}
            </Button>
          ) : (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-h-11 sm:min-h-9"
                onClick={close}
              >
                {t("common.cancel")}
              </Button>
              <Button
                type="submit"
                form={formId}
                size="sm"
                className="min-h-11 sm:min-h-9"
                disabled={creating || !name.trim()}
                data-testid="api-new-token-create"
              >
                {creating ? (
                  <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
                ) : null}
                {t("common.create")}
              </Button>
            </>
          )
        }
      >
        {created ? (
          <div className="space-y-3" data-slot="settings-token-created">
            <div className="flex items-center gap-2 rounded-lg border p-2 pl-3">
              <code
                className="min-w-0 flex-1 font-mono text-sm break-all"
                data-testid="api-new-token-value"
              >
                {token}
              </code>
              <CopyValueButton
                value={token}
                label={t("settings.tokenCopy")}
                testId="api-new-token-copy"
              />
            </div>
            <p className="text-muted-foreground text-sm">
              {t("settings.tokenList.create.shownOnce")}
            </p>
          </div>
        ) : (
          <form
            id={formId}
            onSubmit={(event) => void create(event)}
            className="space-y-4"
            data-slot="api-new-token-form"
          >
            <FieldGroup
              htmlFor={`${formId}-name`}
              label={t("settings.tokenTableName")}
            >
              <Input
                id={`${formId}-name`}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t(MINT_KINDS[kind].placeholderKey)}
                maxLength={100}
                autoComplete="off"
              />
            </FieldGroup>
            <FieldGroup
              htmlFor={`${formId}-scope`}
              label={t("settings.tokenList.scopeColumn")}
              labelAccessory={
                <MoreInfo label={t("settings.tokenList.scopeMoreLabel")}>
                  {t(MINT_KINDS[kind].infoKey)}
                </MoreInfo>
              }
            >
              <NativeSelect
                id={`${formId}-scope`}
                value={kind}
                onChange={(e) => setKind(e.target.value as MintKind)}
                data-testid="api-new-token-scope"
              >
                {(Object.keys(MINT_KINDS) as MintKind[]).map((key) => (
                  <option key={key} value={key}>
                    {t(MINT_KINDS[key].labelKey)}
                  </option>
                ))}
              </NativeSelect>
            </FieldGroup>
            <FieldGroup
              htmlFor={`${formId}-expiry`}
              label={t("settings.tokenList.create.expiry")}
            >
              <NativeSelect
                id={`${formId}-expiry`}
                value={String(days)}
                onChange={(e) => setDays(Number(e.target.value))}
              >
                {EXPIRY_DAYS.map((value) => (
                  <option key={value} value={value}>
                    {value === 365
                      ? t("settings.tokenList.create.expiryYear")
                      : t("settings.tokenList.create.expiryDays", {
                          days: value,
                        })}
                  </option>
                ))}
              </NativeSelect>
            </FieldGroup>
            {kind === "measurements" ? (
              <SwitchRow
                id={`${formId}-mirror`}
                label={t("settings.measurementsToken.appleHealth.label")}
                checked={mirror}
                onCheckedChange={setMirror}
                data-slot="apple-health-mirror-opt-in"
                className="border-t pt-3"
              >
                <MoreInfo label={t("settings.tokenList.mirrorMoreLabel")}>
                  {t("settings.measurementsToken.appleHealth.createHint")}
                </MoreInfo>
              </SwitchRow>
            ) : null}
            {error ? (
              <p role="alert" className="text-destructive text-sm">
                {error}
              </p>
            ) : null}
          </form>
        )}
      </ResponsiveSheet>
    </>
  );
}
