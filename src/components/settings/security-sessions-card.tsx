"use client";

/**
 * v1.23 — Settings → account → "Active sessions" (issue #64).
 *
 * Lists the user's active web sessions (device label, masked IP, resolved
 * location, last-active time, current-device marker) and offers a per-session
 * "sign out" plus a "sign out everywhere else" that revokes every other
 * session (and native device logins) while keeping the current one. All reads
 * + writes route through the centralised query-key factory.
 */
import { useId, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Loader2, MonitorSmartphone } from "lucide-react";

import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { EmptyState } from "@/components/ui/empty-state";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { useTranslations, useFormatters } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { apiGet, apiDelete } from "@/lib/api/api-fetch";
import { CONFIRMS_INLINE } from "@/lib/api/mutation-feedback";
import {
  useAccountGrants,
  useRevokeGrant,
} from "@/lib/queries/use-account-grants";
import { revokeBody } from "@/components/settings/access/grants-given-card";
import { accountLabel } from "@/lib/sharing/account-access-view";
import { cn } from "@/lib/utils";

/** An accepted grant sign-out-everywhere left standing (`grantsKept`). */
export interface KeptGrant {
  id: string;
  account: { id: string; username: string; displayName: string | null };
  access: "READ" | "WRITE" | "MANAGE";
}

const ACCESS_LABEL_KEY: Record<KeptGrant["access"], string> = {
  READ: "recordSharing.invite.accessReadLabel",
  WRITE: "recordSharing.invite.accessWriteLabel",
  MANAGE: "recordSharing.invite.accessManageLabel",
};

interface SessionRow {
  id: string;
  device: string;
  ipMasked: string | null;
  location: string | null;
  lastActiveAt: string | null;
  createdAt: string;
  isCurrent: boolean;
}

export function SecuritySessionsCard({
  isAuthenticated,
}: {
  isAuthenticated: boolean;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<string | null>(null);
  // "Everywhere" also ends clinician share links unless the person keeps
  // them. Revoking is the default: this is often pressed after losing a device,
  // and a link made by whoever held it opens the record without signing in.
  const [endShareLinks, setEndShareLinks] = useState(true);
  // Collapsed until asked for, so the surface stays calm; UI-only state.
  const [open, setOpen] = useState(false);
  const regionId = useId();
  // The people who can still read this record after "sign out everywhere".
  // Their access is not ended by it (a carer who still needs the record would
  // be cut off by a button labelled "sign out"), so they are shown here with
  // a one-click end instead. Held only until the card unmounts.
  const [keptGrants, setKeptGrants] = useState<KeptGrant[]>([]);
  const revokeGrant = useRevokeGrant();
  // Ending one asks the access card's question and disclosure, which names the
  // audit window riding the grant list; read only once there is a row to end.
  const grantListQuery = useAccountGrants(keptGrants.length > 0);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: queryKeys.sessions(),
    queryFn: () => apiGet<{ sessions: SessionRow[] }>("/api/auth/me/sessions"),
    enabled: isAuthenticated,
  });

  const revokeOne = useMutation({
    // Confirms in place: the session leaves the list.
    meta: CONFIRMS_INLINE,
    mutationFn: (id: string) => apiDelete(`/api/auth/me/sessions/${id}`),
    onSuccess: () => {
      setStatus(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.sessions() });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.securityActivity(),
      });
    },
    onError: () => setStatus(t("settings.security.revokeError")),
  });

  const revokeOthers = useMutation({
    // Confirms in place: the status line counts the sessions ended.
    meta: CONFIRMS_INLINE,
    mutationFn: () =>
      apiDelete<{
        sessionsRevoked: number;
        pendingInvitesRevoked?: number;
        grantsKept?: KeptGrant[];
      }>(
        endShareLinks
          ? "/api/auth/me/sessions"
          : "/api/auth/me/sessions?keepShareLinks=1",
      ),
    onSuccess: (res) => {
      const invites = res?.pendingInvitesRevoked ?? 0;
      setStatus(
        [
          t("settings.security.signOutEverywhereDone", {
            count: res?.sessionsRevoked ?? 0,
          }),
          invites > 0
            ? t("settings.security.signOutEverywhereInvitesDone", {
                count: invites,
              })
            : null,
        ]
          .filter(Boolean)
          .join(" "),
      );
      setKeptGrants(res?.grantsKept ?? []);
      void queryClient.invalidateQueries({ queryKey: queryKeys.sessions() });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.securityActivity(),
      });
    },
    onError: () => setStatus(t("settings.security.revokeError")),
  });

  const sessions = data?.sessions ?? [];

  return (
    <SettingsCard data-slot="settings-security-sessions-card">
      <SettingsCardHeader
        anchor="sessions"
        icon={MonitorSmartphone}
        title={
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-controls={regionId}
            data-slot="settings-security-sessions-toggle"
            className="hover:text-foreground focus-visible:ring-ring/50 -m-1 flex min-h-11 items-center gap-2 rounded-md p-1 text-left focus-visible:ring-2 focus-visible:outline-none"
          >
            {t("settings.security.sessionsTitle")}
            <ChevronDown
              aria-hidden="true"
              className={cn(
                "text-muted-foreground size-4 shrink-0 transition-transform",
                open && "rotate-180",
              )}
            />
          </button>
        }
        description={t("settings.security.sessionsDescription")}
      />
      <div id={regionId} hidden={!open} className="space-y-4">
        {isLoading && (
          <Loader2 className="text-muted-foreground h-5 w-5 animate-spin motion-reduce:animate-none" />
        )}

        {isError && (
          <QueryErrorRow
            inset
            error={error}
            message={t("settings.security.sessionsLoadError")}
            onRetry={() => refetch()}
          />
        )}

        {!isLoading && !isError && sessions.length === 0 && (
          <EmptyState
            variant="plain"
            title={t("settings.security.sessionsEmpty")}
          />
        )}

        {sessions.length > 0 && (
          <ul className="divide-border divide-y">
            {sessions.map((s) => (
              <li
                key={s.id}
                className="flex items-center justify-between gap-3 py-3"
                data-slot="security-session-row"
              >
                <div className="min-w-0 space-y-0.5">
                  <p className="truncate text-sm font-medium">
                    {s.device}
                    {s.isCurrent && (
                      <span className="text-success ml-2 text-xs font-normal">
                        {t("settings.security.currentSession")}
                      </span>
                    )}
                  </p>
                  <p className="text-muted-foreground truncate text-xs">
                    {[
                      s.location ?? t("settings.security.unknownLocation"),
                      s.ipMasked,
                    ]
                      .filter(Boolean)
                      .join(", ")}
                  </p>
                  {s.lastActiveAt && (
                    <p className="text-muted-foreground text-xs">
                      {t("settings.security.lastActive", {
                        time: fmt.dateTime(s.lastActiveAt),
                      })}
                    </p>
                  )}
                </div>
                {!s.isCurrent && (
                  <ConfirmButton
                    slot="revoke-session"
                    destructive
                    size="sm"
                    className="min-h-9 shrink-0"
                    label={t("settings.security.revokeSession")}
                    title={t("settings.security.revokeSessionConfirmTitle")}
                    body={t("settings.security.revokeSessionConfirmBody", {
                      device: s.device,
                    })}
                    confirmLabel={t("settings.security.revokeSession")}
                    onConfirm={() => revokeOne.mutate(s.id)}
                    pending={revokeOne.isPending}
                  />
                )}
              </li>
            ))}
          </ul>
        )}

        {status && (
          <p role="status" className="text-muted-foreground text-right text-sm">
            {status}
          </p>
        )}

        <KeptGrantsList
          grants={keptGrants}
          grantList={grantListQuery}
          revokeGrant={revokeGrant}
          onRevoked={(id) =>
            setKeptGrants((current) => current.filter((g) => g.id !== id))
          }
          onRevokeFailed={() =>
            setStatus(t("recordSharing.actionError.revokeFailed"))
          }
        />

        {data && (
          <SettingsCardActions>
            <ConfirmButton
              size="sm"
              slot="sign-out-everywhere"
              destructive
              label={t("settings.security.signOutEverywhere")}
              title={t("settings.security.signOutEverywhereConfirmTitle")}
              body={t("settings.security.signOutEverywhereConfirmBody")}
              confirmLabel={t("settings.security.signOutEverywhere")}
              onConfirm={() => revokeOthers.mutate()}
              pending={revokeOthers.isPending}
              extra={
                <div className="space-y-3">
                  <label className="flex items-start gap-2 text-sm">
                    <Checkbox
                      data-testid="sign-out-everywhere-share-links"
                      checked={endShareLinks}
                      onCheckedChange={(next) =>
                        setEndShareLinks(next === true)
                      }
                      className="mt-0.5"
                    />
                    <span>
                      {t("settings.security.signOutEverywhereShareLinks")}
                    </span>
                  </label>
                  <p className="text-sm">
                    {t("settings.security.signOutEverywhereInvites")}
                  </p>
                </div>
              }
            />
          </SettingsCardActions>
        )}
      </div>
    </SettingsCard>
  );
}

/**
 * The grants "sign out everywhere" left standing, each with its "end access"
 * button. The button asks the access card's question, whose disclosure names
 * the audit window off the grant list; until that list has loaded the button
 * is shown disabled rather than left out, and a failed read says so with a
 * retry instead of leaving the row without its action.
 */
export function KeptGrantsList({
  grants,
  grantList,
  revokeGrant,
  onRevoked,
  onRevokeFailed,
}: {
  grants: readonly KeptGrant[];
  grantList: {
    data?: { retentionDays: number };
    isError: boolean;
    error: unknown;
    refetch: () => unknown;
  };
  /** The revoke mutation; called only from the confirmation's action. */
  revokeGrant: {
    mutate: (
      grantId: string,
      callbacks: { onSuccess: () => void; onError: () => void },
    ) => void;
    isPending: boolean;
  };
  onRevoked: (grantId: string) => void;
  onRevokeFailed: () => void;
}) {
  const { t } = useTranslations();
  if (grants.length === 0) return null;
  const retentionDays = grantList.data?.retentionDays;
  return (
    <div
      data-slot="sign-out-everywhere-grants-kept"
      className="space-y-2 border-t pt-4"
    >
      <p className="text-sm font-medium">
        {t("settings.security.grantsKeptTitle")}
      </p>
      <p className="text-muted-foreground text-sm">
        {t("settings.security.grantsKeptBody")}
      </p>
      {grantList.isError && (
        <QueryErrorRow
          inset
          error={grantList.error}
          onRetry={() => void grantList.refetch()}
        />
      )}
      <ul className="divide-y">
        {grants.map((grant) => (
          <li
            key={grant.id}
            className="flex items-center justify-between gap-3 py-2"
          >
            <div className="min-w-0">
              <p className="truncate text-sm">{accountLabel(grant.account)}</p>
              <p className="text-muted-foreground text-xs">
                {t(ACCESS_LABEL_KEY[grant.access])}
              </p>
            </div>
            <ConfirmButton
              slot="kept-grant-revoke"
              destructive
              size="sm"
              className="min-h-11 shrink-0 sm:min-h-9"
              label={t("recordSharing.given.revoke")}
              title={t("recordSharing.given.revokeTitle", {
                name: accountLabel(grant.account),
              })}
              body={
                retentionDays === undefined
                  ? ""
                  : revokeBody({
                      t,
                      access: grant.access,
                      name: accountLabel(grant.account),
                      retentionDays,
                    })
              }
              confirmLabel={t("recordSharing.given.revokeConfirm")}
              disabled={retentionDays === undefined}
              pending={revokeGrant.isPending}
              onConfirm={() =>
                revokeGrant.mutate(grant.id, {
                  onSuccess: () => onRevoked(grant.id),
                  onError: onRevokeFailed,
                })
              }
            />
          </li>
        ))}
      </ul>
    </div>
  );
}
