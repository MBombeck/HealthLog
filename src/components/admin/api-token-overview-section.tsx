"use client";

import { useQuery } from "@tanstack/react-query";
import { Key, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { formatDate, formatDateTime } from "@/lib/format";
import type { Formatters } from "@/lib/format-locale";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { ListRow } from "@/components/ui/list-row";
import { useTranslations, useFormatters } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { type ApiTokenInfo } from "./_shared";
import { apiGet } from "@/lib/api/api-fetch";

/**
 * Wraps a string in `truncate` + a popover so a long token name /
 * username cannot push the row past its bounds, and a tap still shows all
 * of it.
 *
 * v1.4.19 (4th attempt) — earlier fixes (column-hide,
 * mobile card-list, mobile-strip `no-scrollbar`) cleared every
 * scrollbar the maintainer reported except a residual painted bar they kept
 * seeing at the bottom-right. Production probe confirmed no
 * remaining horizontal-overflow culprits, but the cards still
 * carried `break-all` next to `truncate` (dead code; `white-space:
 * nowrap` from `truncate` beats `word-break: break-all`) and the
 * desktop table cells had no upper-bound on width — a long token
 * name on a 768-1024 px viewport could spill into the next column.
 *
 * Truncating every potentially-long cell means the visible row stays
 * inside the card no matter what the data looks like. The full value opens
 * on a tap or a key (a hover tooltip never opened on a phone); `title`
 * still shows it on hover.
 */
function TruncatedCell({
  value,
  className,
}: {
  value: string;
  className?: string;
}) {
  return (
    <Popover>
      <PopoverTrigger
        className={`focus-visible:ring-ring/50 block w-full truncate rounded-sm text-left focus-visible:ring-2 focus-visible:outline-none ${className ?? ""}`}
        title={value}
      >
        {value}
      </PopoverTrigger>
      <PopoverContent align="start" className="break-all">
        {value}
      </PopoverContent>
    </Popover>
  );
}

/**
 * v1.4.22 — the revoked / isExpired / active
 * 3-way ternary is identical between the desktop table and the
 * mobile card list; the only difference is `text-xs` vs `text-2xs`.
 * Centralise so the two surfaces stay in lock-step.
 */
function TokenStatusBadge({
  token,
  size,
}: {
  token: ApiTokenInfo;
  size: "sm" | "xs";
}) {
  const { t } = useTranslations();
  const expired =
    token.expiresAt != null && new Date(token.expiresAt) < new Date();
  const sizeClass = size === "xs" ? "text-2xs" : "text-xs";
  if (token.revoked) {
    return (
      <Badge variant="destructive" className={`shrink-0 ${sizeClass}`}>
        {t("settings.tokenRevoked")}
      </Badge>
    );
  }
  if (expired) {
    return (
      <Badge variant="destructive" className={`shrink-0 ${sizeClass}`}>
        {t("settings.tokenExpired")}
      </Badge>
    );
  }
  return (
    <Badge className={`bg-success/15 text-success shrink-0 ${sizeClass}`}>
      {t("common.active")}
    </Badge>
  );
}

/**
 * F-18 (v1.4.19): the auto-login flow names tokens
 * "web auto-login 2026-05-05T19:46:20.603Z" / "iOS auto-login …" by
 * suffixing the issuing call's `Date.now().toISOString()`. That suffix
 * makes the admin list look like debug output. Reformat to
 * "iOS auto-login · 05.05.2026 19:46" while leaving any non-ISO suffix
 * (manual names, device fingerprints, etc.) untouched.
 */
// v1.4.22 — broaden the ISO match to include non-Z
// offsets (e.g. `+02:00`, `-05:30`). The previous regex only matched
// UTC (`Z`), so a token name carrying a local-tz timestamp slipped
// through unformatted and rendered the raw `2026-05-05T19:46:20.603+02:00`
// suffix instead of the locale-aware `05.05.2026 21:46` chunk.
const TOKEN_NAME_ISO_RE =
  /^(.+?)\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))(.*)$/;

/**
 * Issue #66 (date-format sweep) — this used to hard-code `de-DE` +
 * `Europe/Berlin`, so a non-German admin saw a German-formatted
 * timestamp baked into the token name regardless of their own locale
 * or profile timezone. Routes through the same `fmt.dateTime` every
 * other surface renders through, so the admin's locale, hour-cycle
 * preference, and profile timezone all apply here too.
 */
function formatTokenName(name: string, fmt: Formatters): string {
  const match = TOKEN_NAME_ISO_RE.exec(name);
  if (!match) return name;
  const [, prefix, iso, rest] = match;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return name;
  // `fmt.dateTime` emits "05.05.2026, 21:46" — strip the comma so the
  // suffix reads as a single date+time chunk.
  const stamp = fmt.dateTime(d).replace(",", "");
  const formatted = `${prefix} · ${stamp}`;
  return rest && rest.trim() ? `${formatted} ${rest.trim()}` : formatted;
}

export function ApiTokenOverviewSection() {
  const { t } = useTranslations();
  const fmt = useFormatters();
  // v1.4.19 — `/admin/api-tokens` is a dedicated single-
  // section route. The previous pattern carried a "Collapse / Expand"
  // toggle as an escape hatch from the v1.4 shared admin page where
  // 13 sections lived together, but on a route that only renders this
  // one card the toggle hides the entire surface. the maintainer reported it
  // as "sinnlos" — gone.
  const { data: tokens, isLoading } = useQuery({
    queryKey: queryKeys.adminTokens(),
    queryFn: async () => {
      return apiGet<ApiTokenInfo[]>("/api/admin/tokens");
    },
  });

  return (
    <SettingsCard className="overflow-hidden">
      <SettingsCardHeader
        icon={Key}
        title={t("admin.apiTokens")}
        description={t("admin.apiTokensDescription")}
      />

      <div>
        {isLoading ? (
          <div className="flex justify-center py-4">
            <Loader2 className="text-muted-foreground h-5 w-5 animate-spin motion-reduce:animate-none" />
          </div>
        ) : !tokens?.length ? (
          // v1.4.15: empty state explains where tokens come
          // from (native client sign-in / Settings → Account) so a
          // fresh admin doesn't think they need to create them here.
          <EmptyState
            icon={<Key className="size-6" />}
            title={t("admin.tokensEmptyTitle")}
            description={t("admin.tokensEmptyDescription")}
          />
        ) : (
          <>
            {/* Desktop table — verbatim layout for md+. The wrapping
                `hidden md:block` swaps it out for the card-list below
                on mobile, mirroring the pattern used in
                `<UserManagementSection>`. `table-fixed` + per-column
                widths give every cell a hard upper bound so a long
                token name cannot expand the row past the card. The
                inner `overflow-x-auto` is a belt-and-suspenders guard
                for medium viewports with extra-long permission
                lists. */}
            <div className="relative hidden overflow-x-auto md:block">
              <table className="w-full table-fixed text-sm">
                <colgroup>
                  <col className="w-[18%]" />
                  <col className="w-[28%]" />
                  <col className="w-[24%]" />
                  <col className="w-[10%]" />
                  <col className="w-[12%]" />
                  <col className="w-[8%]" />
                </colgroup>
                <thead>
                  <tr className="text-muted-foreground border-b text-xs">
                    <th className="px-3 py-2 text-left font-medium">
                      {t("admin.tokenUser")}
                    </th>
                    <th className="px-3 py-2 text-left font-medium">
                      {t("admin.tokenName")}
                    </th>
                    <th className="px-3 py-2 text-left font-medium">
                      {t("admin.tokenPermissions")}
                    </th>
                    <th className="px-3 py-2 text-right font-medium">
                      {t("admin.tokenStatus")}
                    </th>
                    <th className="px-3 py-2 text-right font-medium">
                      {t("admin.tokenLastUsed")}
                    </th>
                    <th className="px-3 py-2 text-right font-medium">
                      {t("admin.tokenCreated")}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-border divide-y">
                  {tokens.map((token, i) => {
                    return (
                      <tr
                        key={token.id}
                        className={i % 2 === 0 ? "bg-muted/30" : ""}
                      >
                        <td className="max-w-0 px-3 py-2 font-medium">
                          <TruncatedCell value={token.user.username} />
                        </td>
                        <td className="max-w-0 px-3 py-2">
                          <TruncatedCell
                            value={formatTokenName(token.name, fmt)}
                          />
                        </td>
                        <td className="max-w-0 px-3 py-2">
                          <div className="flex flex-wrap gap-1">
                            {token.permissions.map((p) => (
                              <Badge
                                key={p}
                                variant="secondary"
                                className="max-w-full truncate text-xs"
                                title={
                                  p === "*"
                                    ? t("admin.tokenPermissionAllTooltip")
                                    : p
                                }
                              >
                                {p === "*" ? t("admin.tokenPermissionAll") : p}
                              </Badge>
                            ))}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-right">
                          <TokenStatusBadge token={token} size="sm" />
                        </td>
                        {/* v1.4.22 (5th attempt) — drop
                            `whitespace-nowrap` on the date cells. The
                            v1.4.19 A7 probe confirmed `formatDateTime`
                            renders "05.05.2026, 21:46" (~110px) which
                            exceeds the 12% `<col>` allotment (~84px on
                            a 700px content area); `whitespace-nowrap`
                            wins over `table-fixed`'s width contract,
                            so the table's intrinsic width exceeds 100%
                            and the wrapper's `overflow-x-auto` paints
                            the scrollbar the maintainer kept reporting
                            for the 5th time. Letting the date+time
                            wrap to two lines on narrow viewports costs
                            one row of height but eliminates the bar. */}
                        <td className="text-muted-foreground px-3 py-2 text-right text-xs">
                          {token.lastUsedAt
                            ? formatDateTime(token.lastUsedAt)
                            : t("admin.tokenNeverUsed")}
                        </td>
                        <td className="text-muted-foreground px-3 py-2 text-right text-xs">
                          {formatDate(token.createdAt)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Mobile card list — each token renders as a self-
                contained card with a stacked meta layout. No
                horizontal scroll: every cell wraps within the card
                width. Mirrors `<UserManagementSection>`. */}
            <ul
              className="space-y-2 md:hidden"
              data-testid="admin-tokens-mobile-list"
            >
              {tokens.map((token) => {
                return (
                  <ListRow
                    asChild
                    key={token.id}
                    className="bg-muted/30 border-border overflow-hidden"
                  >
                    <li>
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <TruncatedCell
                              value={formatTokenName(token.name, fmt)}
                              className="min-w-0 flex-1 font-medium"
                            />
                            <TokenStatusBadge token={token} size="xs" />
                          </div>
                          <TruncatedCell
                            value={token.user.username}
                            className="text-muted-foreground text-xs"
                          />
                        </div>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-1">
                        {token.permissions.map((p) => (
                          <Badge
                            key={p}
                            variant="secondary"
                            className="text-2xs max-w-full truncate"
                            title={
                              p === "*"
                                ? t("admin.tokenPermissionAllTooltip")
                                : p
                            }
                          >
                            {p === "*" ? t("admin.tokenPermissionAll") : p}
                          </Badge>
                        ))}
                      </div>
                      <p className="text-muted-foreground mt-2 text-xs">
                        {t("admin.tokenLastUsed")}:{" "}
                        {token.lastUsedAt
                          ? formatDateTime(token.lastUsedAt)
                          : t("admin.tokenNeverUsed")}
                      </p>
                      <p className="text-muted-foreground text-xs">
                        {t("admin.tokenCreated")}: {formatDate(token.createdAt)}
                      </p>
                    </li>
                  </ListRow>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </SettingsCard>
  );
}
