"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import { useMounted } from "@/hooks/use-mounted";
import { usePullToRefresh } from "@/hooks/use-pull-to-refresh";
import { MoodForm } from "@/components/mood/mood-form";
import { MoodList } from "@/components/mood/mood-list";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { PageAuthGate } from "@/components/ui/page-auth-gate";
import { PullToRefreshIndicator } from "@/components/ui/pull-to-refresh-indicator";
import {
  ResponsiveSheet,
  sheetBodyHasUnsavedInput,
} from "@/components/ui/responsive-sheet";
import { ArrowRight, Plus, Wrench } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { useTranslations } from "@/lib/i18n/context";
import { InlineAction } from "@/components/ui/inline-action";
import { writeUrlState } from "@/lib/url-state";

export default function MoodPageClient() {
  const { user, isAuthenticated, isLoading } = useAuth();
  const {
    canManageDomain,
    inSharedRecord,
    recordSessionPending,
    accessRefused,
  } = useRecordCapabilities();
  // A mood entry is created at MANAGE under the mind section.
  const canAddMood = canManageDomain("mind");
  const mounted = useMounted();
  const router = useRouter();
  const queryClient = useQueryClient();
  const searchParams = useSearchParams();
  // `?add=1` opens the entry sheet on the first paint: the mood reminder's
  // tap target (`tap-target.ts`). Read in the lazy initialiser so SSR and the
  // hydration render agree; the effect below strips the one-shot param so the
  // back button does not reopen the sheet. A later client-side navigation
  // back onto `?add=1` is handled render-side, the measurements-page pattern.
  //
  // The request is held apart from the sheet's own open state because it is
  // honoured only in the caller's own record. A reminder is about the person
  // who receives it; a session that is currently inside a managed profile or
  // a shared record would otherwise open a write form there, and an entry
  // saved from it lands on the wrong person. In that case the page opens
  // without the sheet and the shell's shared-record banner offers the way
  // back. The answer is read once the account query settled (`isLoading`
  // gates the content render), so the request is dropped, not deferred: a
  // later switch back to the own record must not pop a stale sheet.
  const addParam = searchParams.get("add") === "1";
  const [dialogOpen, setDialogOpen] = useState(false);
  const [addRequested, setAddRequested] = useState(() => addParam);
  const [consumedAdd, setConsumedAdd] = useState(() => addParam);
  if (!addParam && consumedAdd) {
    setConsumedAdd(false);
  } else if (addParam && !consumedAdd) {
    setConsumedAdd(true);
    setAddRequested(true);
  }
  const ownRecord = !inSharedRecord && !recordSessionPending && !accessRefused;
  if (addRequested && mounted && !isLoading && !ownRecord) {
    setAddRequested(false);
  }
  const sheetOpen = (dialogOpen || (addRequested && ownRecord)) && canAddMood;
  const setSheetOpen = useCallback((open: boolean) => {
    setDialogOpen(open);
    if (!open) setAddRequested(false);
  }, []);
  // The list's empty state carries the add action while there is nothing
  // to list, so the header drops its own then.
  const [listEmpty, setListEmpty] = useState(false);
  // v1.4.27 — DOM-ref handle the form portals its action row
  // into. The ref lives on the `<ResponsiveSheet>` footer slot so the
  // Sheet branch can sticky-pin Save / Cancel above the keyboard.
  const [footerEl, setFooterEl] = useState<HTMLDivElement | null>(null);
  const { t } = useTranslations();

  // Gated on the resolved `modules.mood` flag from `GET /api/auth/me` (the
  // per-user toggle AND the operator server-wide kill-switch). Default-on: an
  // absent key reads as enabled, so a direct URL hit only bounces on an
  // explicit `false`. Every `/api/mood-entries/*` route also enforces the gate
  // server-side, so this is a UX redirect, not the security boundary.
  const enabled = user?.modules?.mood !== false;

  // v1.16.4 — PWA pull-to-refresh: a top-anchored touch pull refetches
  // whatever this page currently has mounted (`type: "active"` scopes the
  // invalidation to visible queries). Suspended while the add-sheet is
  // open so a drag inside the form can't arm the gesture.
  const refreshVisible = useCallback(
    () => queryClient.invalidateQueries({ type: "active" }),
    [queryClient],
  );
  const pull = usePullToRefresh({
    onRefresh: refreshVisible,
    disabled: sheetOpen,
  });

  useEffect(() => {
    if (!searchParams.has("add")) return;
    // From the live query at the moment of the write, never the rendered
    // copy, so a filter written meanwhile is kept (`@/lib/url-state`).
    writeUrlState((params) => params.delete("add"), { afterPaint: true });
  }, [searchParams]);

  useEffect(() => {
    if (isLoading) return;
    if (!isAuthenticated) {
      router.push("/auth/login");
    } else if (!enabled) {
      router.push("/");
    }
  }, [isLoading, isAuthenticated, enabled, router]);

  // `!mounted` keeps the hydration render identical to the SSR HTML: the
  // auth query is fired by the early-hydrating shell and can settle before
  // this page boundary hydrates, so `isLoading` alone flipped the branch
  // and React logged hydration error #418 — same fix as the measurements
  // page; see `useMounted`.
  if (!mounted || isLoading || (isAuthenticated && !enabled)) {
    return <PageAuthGate label={t("common.loading")} />;
  }

  return (
    <div className="space-y-6">
      <PullToRefreshIndicator {...pull} />
      <PageHeader
        title={<span data-tour-id="mood-hero">{t("mood.title")}</span>}
        description={t("mood.subtitle")}
        actions={
          <>
            {/* v1.17 — the wrench is the one customize entry point: it
                links to /settings/mood, which owns the tag groups, custom
                tags, visibility, and picker order. Same glyph, slot (left
                of the add button) and responsive 44-px mobile tap floor
                as the medications header.

                v1.36.x — and gated like the other four wrenches. It was the
                one of five left open, so a delegate tapped it straight into
                the "not part of what was shared" panel: `/settings` is not a
                shared-record destination and the shell answers before the
                page does. */}
            {!inSharedRecord && (
              <Button
                asChild
                variant="ghost"
                size="icon"
                className="min-h-11 min-w-11 sm:min-h-9 sm:min-w-9"
              >
                <Link
                  href="/settings/modules/mood"
                  aria-label={t("mood.customize")}
                  title={t("mood.customize")}
                >
                  <Wrench className="h-4 w-4" aria-hidden="true" />
                </Link>
              </Button>
            )}
            {/* A mood entry is a MANAGE create: a WRITE delegate gets no add
                path here, a guardian or a MANAGE delegate does. */}
            {canAddMood && !listEmpty && (
              <Button
                onClick={() => setDialogOpen(true)}
                className="min-h-11 sm:min-h-9"
                data-slot="mood-add-entry"
              >
                <Plus className="h-4 w-4" />
                {t("mood.addEntry")}
              </Button>
            )}
          </>
        }
      />

      <ResponsiveSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        dirty={sheetBodyHasUnsavedInput}
        title={t("dashboard.quickAddMood")}
        footer={<div ref={setFooterEl} className="flex w-full" />}
      >
        <MoodForm
          onSuccess={() => setSheetOpen(false)}
          onCancel={() => setSheetOpen(false)}
          footerSlot={footerEl}
        />
      </ResponsiveSheet>

      <MoodList
        onAddFirst={() => setDialogOpen(true)}
        onEmptyChange={setListEmpty}
      />

      {/* Mood tracking, the mental-wellbeing
          screeners, and the mood insights page form one mental-health
          domain but used to be three unconnected islands. A quiet pointer
          here (module-gated — no nav change) rather than a merge: capture
          vs. screener stay two defensible surfaces, just cross-linked. */}
      {user?.modules?.mentalHealth === true ? (
        <InlineAction asChild tone="muted" size="sm" className="gap-1.5">
          <Link href="/mental-wellbeing" data-slot="mood-mental-wellbeing-link">
            {t("mood.mentalWellbeingLink")}
            <ArrowRight className="size-3.5" aria-hidden="true" />
          </Link>
        </InlineAction>
      ) : null}
    </div>
  );
}
