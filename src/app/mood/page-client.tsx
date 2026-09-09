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
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { ArrowRight, Plus, Wrench } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useTranslations } from "@/lib/i18n/context";

export default function MoodPageClient() {
  const { user, isAuthenticated, isLoading } = useAuth();
  const { canManageDomain, inSharedRecord } = useRecordCapabilities();
  // A mood entry is created at MANAGE under the mind section.
  const canAddMood = canManageDomain("mind");
  const mounted = useMounted();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  // v1.4.27 R4 RC2 — DOM-ref handle the form portals its action row
  // into. The ref lives on the `<ResponsiveSheet>` footer slot so the
  // Sheet branch can sticky-pin Save / Cancel above the keyboard.
  const [footerEl, setFooterEl] = useState<HTMLDivElement | null>(null);
  const { t } = useTranslations();

  // Gated on the resolved `modules.mood` flag from `GET /api/auth/me` (the
  // per-user toggle AND the operator server-wide kill-switch). Default-on: an
  // absent key reads as enabled, so a direct URL hit only bounces on an
  // explicit `false`. Every `/api/mood-entries/*` route also enforces the gate
  // server-side, so this is a UX redirect, not the security boundary.
  const enabled = inSharedRecord || user?.modules?.mood !== false;

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
    disabled: dialogOpen,
  });

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
                  href="/settings/layout/mood"
                  aria-label={t("mood.customize")}
                  title={t("mood.customize")}
                >
                  <Wrench className="h-4 w-4" aria-hidden="true" />
                </Link>
              </Button>
            )}
            {/* A mood entry is a MANAGE create: a WRITE delegate gets no add
                path here, a guardian or a MANAGE delegate does. */}
            {canAddMood && (
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
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        title={t("mood.addEntry")}
        footer={<div ref={setFooterEl} className="flex w-full" />}
      >
        <MoodForm
          onSuccess={() => setDialogOpen(false)}
          onCancel={() => setDialogOpen(false)}
          footerSlot={footerEl}
        />
      </ResponsiveSheet>

      <MoodList onAddFirst={() => setDialogOpen(true)} />

      {/* 2026-07-17 UX/IA audit M9 — mood tracking, the mental-wellbeing
          screeners, and the mood insights page form one mental-health
          domain but used to be three unconnected islands. A quiet pointer
          here (module-gated — no nav change) rather than a merge: capture
          vs. screener stay two defensible surfaces, just cross-linked. */}
      {user?.modules?.mentalHealth === true ? (
        <Link
          href="/mental-wellbeing"
          data-slot="mood-mental-wellbeing-link"
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 inline-flex items-center gap-1.5 text-sm underline-offset-4 transition-colors hover:underline focus-visible:ring-[3px] focus-visible:outline-none"
        >
          {t("mood.mentalWellbeingLink")}
          <ArrowRight className="size-3.5" aria-hidden="true" />
        </Link>
      ) : null}
    </div>
  );
}
