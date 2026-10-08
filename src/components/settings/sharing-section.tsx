"use client";

/**
 * v1.11.0 — Settings → Sharing (Epic C, C7).
 *
 * The OWNER surface for clinician share links. A share link is a time-boxed,
 * scope-frozen, read-only view of the owner's own health record at
 * `/c/<token>`, optionally exposing a scoped read-only FHIR face. The raw
 * `hls_` token is shown EXACTLY ONCE on create — the list never carries it
 * (the server only stores its hash).
 *
 * The create form + one-time reveal live in the shared `ShareLinkCreateForm`
 * (mounted here and from the document detail sheet's Share action); this
 * section owns the create card chrome plus the active/revoked lists and the
 * revoke action. Reads unwrap `(await res.json()).data`; the query key comes
 * from the centralised factory. No markdown anywhere — every value renders as
 * escaped React text.
 *
 * v1.18.7 — restored as a first-class Settings section. The visible heading +
 * subtitle now come from the shared shell chrome in the route; this body is
 * the share-links card. Cards paint through `<SettingsCard>` so the surface
 * matches every sibling section 1:1.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, KeyRound, Link2, List, Trash2 } from "lucide-react";

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
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { Skeleton } from "@/components/ui/skeleton";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import {
  MAX_DAYS,
  ShareLinkCreateForm,
  type ShareLinkSummary,
} from "@/components/settings/share-link-create-form";
import { useAuth } from "@/hooks/use-auth";
import { formatDate, formatDateTime } from "@/lib/format";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { apiDelete, apiGet } from "@/lib/api/api-fetch";

export function SharingSection() {
  // v1.18.7 — the visible heading + subtitle come from the shared settings
  // shell chrome in the route; this body is the share-links card only.
  return (
    <div className="space-y-6">
      <ShareLinksCard />
    </div>
  );
}

/**
 * Carry a closed link's window and lifetime into a new create form.
 *
 * The window is measured from the frozen `rangeStart` to now (a rolling link
 * has no end), the lifetime from when it was created to when it would have
 * expired. Both are clamped into the form's own bounds so a very old link
 * cannot seed an out-of-range value.
 */
function prefillFrom(link: ShareLinkSummary) {
  const day = 86_400_000;
  const rangeDays = Math.max(
    1,
    Math.round((Date.now() - new Date(link.rangeStart).getTime()) / day),
  );
  const expiryDays = Math.min(
    MAX_DAYS,
    Math.max(
      1,
      Math.round(
        (new Date(link.expiresAt).getTime() -
          new Date(link.createdAt).getTime()) /
          day,
      ),
    ),
  );
  return { key: Date.now(), label: link.label, rangeDays, expiryDays };
}

function ShareLinksCard() {
  const { t } = useTranslations();
  const { isAuthenticated } = useAuth();
  const queryClient = useQueryClient();

  const [showRevoked, setShowRevoked] = useState(false);
  // A re-mint carries the closed link's label, window and lifetime across, so
  // the only thing left to decide is the scope it never had. Keyed so the form
  // remounts and picks the values up as its initial state.
  const [prefill, setPrefill] = useState<{
    key: number;
    label: string;
    rangeDays: number;
    expiryDays: number;
  } | null>(null);

  const {
    data: links,
    isError,
    isLoading,
    refetch,
  } = useQuery({
    queryKey: queryKeys.shareLinks(),
    queryFn: () =>
      apiGet<{ shareLinks: ShareLinkSummary[] }>("/api/share-links").then(
        (data) => data.shareLinks,
      ),
    enabled: isAuthenticated,
  });

  const revokeMutation = useMutation({
    mutationFn: (id: string) => apiDelete(`/api/share-links/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.shareLinks() });
    },
  });

  const activeLinks = useMemo(
    () => (links ?? []).filter((l) => l.active),
    [links],
  );
  const inactiveLinks = useMemo(
    () => (links ?? []).filter((l) => !l.active),
    [links],
  );

  // Two cards: making a link and the links already out are separate jobs, and
  // a growing list under the form pushed the create action out of reach.
  return (
    <>
      <SettingsCard id="share-link-create" className="scroll-mt-28">
        <SettingsCardHeader
          icon={Link2}
          title={t("settings.sharing.createTitle")}
          description={t("settings.sharing.createDescription")}
        />
        <p className="text-sm">{t("settings.sharing.createDetail")}</p>

        <ShareLinkCreateForm
          key={prefill?.key ?? "new"}
          initialLabel={prefill?.label}
          initialRangeDays={prefill?.rangeDays}
          initialExpiryDays={prefill?.expiryDays}
        />
      </SettingsCard>

      <SettingsCard data-testid="share-links-card">
        <SettingsCardHeader
          icon={List}
          title={t("settings.sharing.activeTitle")}
          description={t("settings.sharing.activeDescription")}
        />
        {isError ? (
          // A read failure must not read as "no active links" on a clinical
          // sharing surface — that is the §6 fall-through this card must avoid.
          <QueryErrorCard onRetry={() => refetch()} />
        ) : isLoading ? (
          <div className="space-y-2" data-testid="share-links-loading">
            <Skeleton className="h-24 w-full rounded-lg" />
            <Skeleton className="h-24 w-full rounded-lg" />
          </div>
        ) : (
          <>
            <div className="space-y-2">
              {activeLinks.length === 0 ? (
                <EmptyState
                  size="compact"
                  data-testid="share-active-empty"
                  title={t("settings.sharing.noActive")}
                />
              ) : (
                <ul className="space-y-2" data-testid="share-active-list">
                  {activeLinks.map((link) => (
                    <li
                      key={link.id}
                      className="bg-muted/30 border-border space-y-2 rounded-lg border p-3"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <p className="min-w-0 flex-1 text-sm font-medium break-words">
                          {link.label}
                        </p>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Badge className="bg-success/15 text-success text-xs">
                            {t("settings.sharing.statusActive")}
                          </Badge>
                          {link.protected && (
                            <Badge
                              variant="outline"
                              className="gap-1 text-xs"
                              data-testid="share-protected-badge"
                            >
                              <KeyRound className="h-2.5 w-2.5" />
                              {t("settings.sharing.protected")}
                            </Badge>
                          )}
                          {link.documentCount > 0 && (
                            <Badge
                              variant="outline"
                              className="gap-1 text-xs"
                              data-testid="share-doc-count-badge"
                              aria-label={t("settings.sharing.documentCount", {
                                count: link.documentCount,
                              })}
                            >
                              <FileText className="h-2.5 w-2.5" />
                              {link.documentCount}
                            </Badge>
                          )}
                        </div>
                      </div>
                      <p className="text-muted-foreground text-xs">
                        <span className="font-medium">
                          {t("settings.sharing.created")}:
                        </span>{" "}
                        {formatDate(link.createdAt)}
                      </p>
                      <p className="text-muted-foreground text-xs">
                        <span className="font-medium">
                          {t("settings.sharing.expires")}:
                        </span>{" "}
                        {formatDateTime(link.expiresAt)}
                      </p>
                      <p className="text-muted-foreground text-xs">
                        <span className="font-medium">
                          {t("settings.sharing.accessCount")}:
                        </span>{" "}
                        {link.accessCount}
                        {link.lastAccessAt
                          ? ` · ${formatDateTime(link.lastAccessAt)}`
                          : ""}
                      </p>
                      {/* §12 — a right-aligned row action, not a full-width
                        destructive strip stacked once per link (which reads as
                        an alarm wall on a list of shares). */}
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            variant="outline"
                            size="sm"
                            className="ml-auto flex min-h-11 w-fit sm:min-h-9"
                          >
                            <Trash2 className="mr-2 h-3.5 w-3.5" />
                            {t("settings.sharing.revoke")}
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>
                              {t("settings.sharing.revoke")}
                            </AlertDialogTitle>
                            <AlertDialogDescription>
                              {t("settings.sharing.revokeDescription")}
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>
                              {t("common.cancel")}
                            </AlertDialogCancel>
                            <AlertDialogAction
                              onClick={() => revokeMutation.mutate(link.id)}
                            >
                              {t("settings.sharing.revoke")}
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {inactiveLinks.length > 0 && (
              <div className="space-y-2">
                <button
                  type="button"
                  onClick={() => setShowRevoked((prev) => !prev)}
                  className="text-foreground hover:text-primary text-sm font-medium transition-colors"
                >
                  {t("settings.sharing.inactiveTitle", {
                    count: inactiveLinks.length,
                  })}
                </button>
                {showRevoked && (
                  <ul className="space-y-2" data-testid="share-inactive-list">
                    {inactiveLinks.map((link) => (
                      <li
                        key={link.id}
                        className="bg-muted/20 border-border space-y-1.5 rounded-lg border p-3"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <p className="min-w-0 flex-1 text-sm font-medium break-words">
                            {link.label}
                          </p>
                          <Badge variant="secondary" className="text-xs">
                            {link.needsReselection
                              ? t("settings.sharing.statusNeedsReselect")
                              : link.revokedAt
                                ? t("settings.sharing.statusRevoked")
                                : t("settings.sharing.statusExpired")}
                          </Badge>
                        </div>
                        {/* A link whose frozen scope predates the selection model.
                      It served a scope nobody chose, so it was closed; the
                      owner re-mints above with the label, window and expiry
                      still in front of them. */}
                        {link.needsReselection ? (
                          <div
                            className="space-y-1.5"
                            data-testid={`share-needs-reselect-${link.id}`}
                          >
                            <p className="text-muted-foreground text-xs">
                              {t("settings.sharing.reselectReason")}
                            </p>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="min-h-11 sm:min-h-9"
                              data-testid={`share-reselect-${link.id}`}
                              onClick={() => {
                                setPrefill(prefillFrom(link));
                                // The form it fills sits in the card above.
                                document
                                  .getElementById("share-link-create")
                                  ?.scrollIntoView({ block: "start" });
                              }}
                            >
                              {t("settings.sharing.reselectAction")}
                            </Button>
                          </div>
                        ) : null}
                        <p className="text-muted-foreground text-xs">
                          <span className="font-medium">
                            {t("settings.sharing.accessCount")}:
                          </span>{" "}
                          {link.accessCount}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </>
        )}
      </SettingsCard>
    </>
  );
}
