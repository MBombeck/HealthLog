"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  ExternalLink,
  GitPullRequest,
  Inbox,
  Loader2,
  MessageSquare,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatDateTime } from "@/lib/format";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import {
  FEEDBACK_STATUS_TABS,
  type FeedbackCategoryType,
  type FeedbackItem,
  type FeedbackListResponse,
  type FeedbackStatusType,
  getApiErrorMessage,
  useSystemStatus,
} from "./_shared";

export function FeedbackInboxSection() {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const { data: status } = useSystemStatus();
  const githubConfigured = Boolean(status?.integrations?.bugReport?.configured);

  const [activeStatus, setActiveStatus] = useState<FeedbackStatusType>("OPEN");
  const [selected, setSelected] = useState<FeedbackItem | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.adminFeedback(activeStatus),
    queryFn: async () => {
      const res = await fetch(
        `/api/admin/feedback?status=${activeStatus}&limit=100`,
      );
      if (!res.ok) throw new Error("Failed");
      return (await res.json()).data as FeedbackListResponse;
    },
  });

  const counts = data?.meta?.countsByStatus ?? {};

  function refresh() {
    queryClient.invalidateQueries({ queryKey: queryKeys.adminFeedbackRoot() });
  }

  return (
    <div className="bg-card border-border rounded-xl border p-6">
      {/* v1.4.19 A8 / F-08 + F-20: this is the only card on
          `/admin/feedback`, so the page header already provides the
          title + description — the card-level repetition was just
          visual noise. The icon stays as a low-key card affordance. */}
      <Inbox className="text-primary h-5 w-5" aria-hidden="true" />

      <Tabs
        value={activeStatus}
        onValueChange={(v) => setActiveStatus(v as FeedbackStatusType)}
        className="mt-4"
      >
        {/* v1.4.27 MB7 / CF-55 — wrap the TabsList in an
            overflow-x-auto strip so the 4 status pills + their count
            badges scroll horizontally on Pixel 5 / Galaxy Fold
            instead of squashing the badge text below the legibility
            floor. Hide the scrollbar visually but keep the gesture
            working (matches the Insights tab-strip pattern). */}
        <div className="-mx-1 overflow-x-auto px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <TabsList>
            {FEEDBACK_STATUS_TABS.map((s) => (
              <TabsTrigger key={s} value={s}>
                <span>
                  {t(
                    `admin.feedback.tab${s.charAt(0) + s.slice(1).toLowerCase()}`,
                  )}
                </span>
                <Badge variant="secondary" className="ml-1.5 text-xs">
                  {counts[s] ?? 0}
                </Badge>
              </TabsTrigger>
            ))}
          </TabsList>
        </div>

        {FEEDBACK_STATUS_TABS.map((s) => (
          <TabsContent key={s} value={s} className="mt-4">
            {isLoading ? (
              <div className="flex items-center gap-2">
                <Loader2 className="text-muted-foreground h-4 w-4 animate-spin motion-reduce:animate-none" />
                <span className="text-muted-foreground text-sm">
                  {t("admin.feedback.loading")}
                </span>
              </div>
            ) : !data?.items?.length ? (
              // v1.4.15 phase-C5: per-tab empty state. Compact size so
              // it sits naturally under the tab strip without dwarfing
              // a typical 1-2-row inbox once entries arrive.
              <EmptyState
                size="compact"
                icon={<Inbox className="size-5" />}
                title={t("admin.feedback.emptyTitle")}
                description={t("admin.feedback.emptyDescription")}
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-muted-foreground border-b text-xs">
                      <th className="px-3 py-2 text-left font-medium">
                        {t("admin.feedback.createdAt")}
                      </th>
                      <th className="px-3 py-2 text-left font-medium">
                        {t("admin.feedback.category")}
                      </th>
                      <th className="px-3 py-2 text-left font-medium">
                        {t("admin.feedback.subject")}
                      </th>
                      <th className="px-3 py-2 text-left font-medium">
                        {t("admin.feedback.user")}
                      </th>
                      <th className="px-3 py-2 text-right font-medium">
                        {t("admin.feedback.actions")}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-border divide-y">
                    {data.items.map((item, i) => (
                      <tr
                        key={item.id}
                        className={`hover:bg-muted/40 cursor-pointer ${i % 2 === 0 ? "bg-muted/30" : ""}`}
                        onClick={() => setSelected(item)}
                      >
                        <td className="text-muted-foreground px-3 py-2 text-xs whitespace-nowrap">
                          {formatDateTime(item.createdAt)}
                        </td>
                        <td className="px-3 py-2">
                          <FeedbackCategoryBadge category={item.category} />
                        </td>
                        <td className="max-w-[28ch] truncate px-3 py-2 font-medium">
                          {item.subject}
                        </td>
                        <td className="text-muted-foreground px-3 py-2 text-xs">
                          {item.user?.username ?? t("admin.feedback.anonymous")}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs"
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelected(item);
                            }}
                          >
                            {t("admin.feedback.details")}
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </TabsContent>
        ))}
      </Tabs>

      {selected && (
        <FeedbackDetailDialog
          item={selected}
          open={!!selected}
          onOpenChange={(open) => !open && setSelected(null)}
          githubConfigured={githubConfigured}
          onMutated={refresh}
        />
      )}
    </div>
  );
}

function FeedbackCategoryBadge({
  category,
}: {
  category: FeedbackCategoryType;
}) {
  const { t } = useTranslations();
  const map: Record<
    FeedbackCategoryType,
    { label: string; className: string }
  > = {
    BUG: {
      label: t("admin.feedback.categoryBug"),
      // Bug = something that's broken → semantic `destructive` token instead
      // of raw `dracula-red`. Visually identical in dark mode (both resolve
      // to #ff5555); light mode now picks up the AA-contrast `#cb3a2a`.
      className: "bg-destructive/15 text-destructive border-destructive/30",
    },
    FEATURE_REQUEST: {
      label: t("admin.feedback.categoryFeature"),
      className:
        "bg-dracula-purple/15 text-dracula-purple border-dracula-purple/30",
    },
    QUESTION: {
      label: t("admin.feedback.categoryQuestion"),
      className: "bg-dracula-cyan/15 text-dracula-cyan border-dracula-cyan/30",
    },
    OTHER: {
      label: t("admin.feedback.categoryOther"),
      className: "bg-muted text-muted-foreground border-border",
    },
  };
  const cfg = map[category];
  return (
    <Badge className={`border text-xs ${cfg.className}`}>{cfg.label}</Badge>
  );
}

function FeedbackDetailDialog({
  item,
  open,
  onOpenChange,
  githubConfigured,
  onMutated,
}: {
  item: FeedbackItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  githubConfigured: boolean;
  onMutated: () => void;
}) {
  const { t } = useTranslations();
  const [note, setNote] = useState(item.adminNote ?? "");
  const [issueUrl, setIssueUrl] = useState(item.gitHubIssueUrl);

  const update = useMutation({
    mutationFn: async (payload: {
      status?: FeedbackStatusType;
      adminNote?: string | null;
    }) => {
      const res = await fetch(`/api/admin/feedback/${item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(await getApiErrorMessage(res));
    },
    onSuccess: (_, vars) => {
      onMutated();
      if (vars.adminNote !== undefined) {
        toast.success(t("admin.feedback.noteSaved"));
      }
    },
    onError: (err) => {
      toast.error(
        err instanceof Error ? err.message : t("admin.feedback.updateFailed"),
      );
    },
  });

  const archive = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/admin/feedback/${item.id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(await getApiErrorMessage(res));
    },
    onSuccess: () => {
      onMutated();
      onOpenChange(false);
    },
    onError: (err) => {
      toast.error(
        err instanceof Error ? err.message : t("admin.feedback.updateFailed"),
      );
    },
  });

  const publish = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/admin/feedback/${item.id}/github`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(await getApiErrorMessage(res));
      return (await res.json()).data as { issueUrl: string };
    },
    onSuccess: (data) => {
      setIssueUrl(data.issueUrl);
      toast.success(t("admin.feedback.publishSuccess"));
      onMutated();
    },
    onError: (err) => {
      toast.error(
        err instanceof Error ? err.message : t("admin.feedback.publishFailed"),
      );
    },
  });

  const meta = item.metadata ?? {};
  const url = typeof meta.url === "string" ? meta.url : null;
  const locale = typeof meta.locale === "string" ? meta.locale : null;
  const userAgent = typeof meta.userAgent === "string" ? meta.userAgent : null;
  const appVersion =
    typeof meta.appVersion === "string" ? meta.appVersion : null;

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      title={
        <span className="flex items-center gap-2">
          <MessageSquare className="h-5 w-5" />
          {item.subject}
        </span>
      }
      description={
        <span className="flex flex-wrap items-center gap-2 text-xs">
          <FeedbackCategoryBadge category={item.category} />
          <span>
            {t("admin.feedback.submittedBy")}:{" "}
            {item.user?.username ?? t("admin.feedback.anonymous")}
          </span>
          <span>·</span>
          <span>{formatDateTime(item.createdAt)}</span>
          {issueUrl && (
            <a
              href={issueUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary inline-flex items-center gap-1"
            >
              <GitPullRequest className="h-3 w-3" />
              {t("admin.feedback.viewIssue")}
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </span>
      }
      className="sm:max-w-2xl"
      footer={
        <div className="flex w-full flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={update.isPending || item.status === "ACKNOWLEDGED"}
            onClick={() => update.mutate({ status: "ACKNOWLEDGED" })}
          >
            <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />
            {t("admin.feedback.actionAcknowledge")}
          </Button>
          <Button
            size="sm"
            disabled={update.isPending || item.status === "RESOLVED"}
            onClick={() => update.mutate({ status: "RESOLVED" })}
          >
            <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />
            {t("admin.feedback.actionResolve")}
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                size="sm"
                variant="destructive"
                disabled={archive.isPending || item.status === "ARCHIVED"}
              >
                <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                {t("admin.feedback.actionArchive")}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {t("admin.feedback.archiveConfirm")}
                </AlertDialogTitle>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => archive.mutate()}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  {t("admin.feedback.actionArchive")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          {githubConfigured && !issueUrl && (
            <Button
              size="sm"
              variant="outline"
              disabled={publish.isPending}
              onClick={() => publish.mutate()}
              className="ml-auto"
            >
              {publish.isPending ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
              ) : (
                <GitPullRequest className="mr-1.5 h-3.5 w-3.5" />
              )}
              {t("admin.feedback.actionPublishGithub")}
            </Button>
          )}
          {issueUrl && (
            <Badge className="border-success/30 bg-success/15 text-success ml-auto">
              {t("admin.feedback.publishedToGithub")}
            </Badge>
          )}
        </div>
      }
    >
        <div className="space-y-4 text-sm">
          <div className="bg-muted/40 rounded-md p-3 whitespace-pre-wrap">
            {item.description}
          </div>

          {(url || locale || userAgent || appVersion) && (
            <div>
              {/* v1.4.33 IW9 — h4 -> h3 so the sheet outline stays
                  sequential beneath the ResponsiveSheet's h2 title. */}
              <h3 className="text-muted-foreground text-xs font-semibold tracking-wider uppercase">
                {t("admin.feedback.metadataHeading")}
              </h3>
              <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
                {url && (
                  <>
                    <dt className="text-muted-foreground">
                      {t("admin.feedback.metaUrl")}
                    </dt>
                    <dd className="font-mono break-all">{url}</dd>
                  </>
                )}
                {locale && (
                  <>
                    <dt className="text-muted-foreground">
                      {t("admin.feedback.metaLocale")}
                    </dt>
                    <dd className="font-mono">{locale}</dd>
                  </>
                )}
                {appVersion && (
                  <>
                    <dt className="text-muted-foreground">
                      {t("admin.feedback.metaAppVersion")}
                    </dt>
                    <dd className="font-mono">{appVersion}</dd>
                  </>
                )}
                {userAgent && (
                  <>
                    <dt className="text-muted-foreground">
                      {t("admin.feedback.metaUserAgent")}
                    </dt>
                    <dd className="font-mono break-all">{userAgent}</dd>
                  </>
                )}
              </dl>
            </div>
          )}

          {item.screenshotBase64 && (
            <div>
              <h3 className="text-muted-foreground mb-2 text-xs font-semibold tracking-wider uppercase">
                {t("admin.feedback.screenshotHeading")}
              </h3>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={item.screenshotBase64}
                alt="Screenshot"
                className="border-border max-h-72 rounded-md border"
              />
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="admin-feedback-note" className="text-xs">
              {t("admin.feedback.adminNote")}
            </Label>
            <textarea
              id="admin-feedback-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              maxLength={5000}
              placeholder={t("admin.feedback.adminNotePlaceholder")}
              // text-base on mobile so iOS Safari doesn't zoom on
              // focus; text-sm on sm+ keeps the compact admin look.
              className="border-input bg-background text-foreground placeholder:text-muted-foreground focus-visible:ring-ring w-full rounded-md border px-3 py-2 text-base focus-visible:ring-2 focus-visible:outline-none sm:text-sm"
            />
            <div className="flex justify-end">
              <Button
                size="sm"
                variant="outline"
                disabled={update.isPending || note === (item.adminNote ?? "")}
                onClick={() => update.mutate({ adminNote: note || null })}
              >
                {update.isPending && (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                )}
                {t("admin.feedback.saveNote")}
              </Button>
            </div>
          </div>

        </div>
    </ResponsiveSheet>
  );
}
