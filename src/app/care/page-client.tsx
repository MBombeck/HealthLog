"use client";

import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";

import { useAuth } from "@/hooks/use-auth";
import { useMounted } from "@/hooks/use-mounted";
import { usePullToRefresh } from "@/hooks/use-pull-to-refresh";
import { PullToRefreshIndicator } from "@/components/ui/pull-to-refresh-indicator";
import { PageAuthGate } from "@/components/ui/page-auth-gate";
import { HeaderSlotProvider } from "@/components/layout/header-slot";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { VorsorgeSection } from "@/components/measurement-reminders/vorsorge-section";
import { VisitsSection } from "@/components/encounters/visits-section";
import { ProceduresSection } from "@/components/encounters/procedures-section";
import { BodySitesSection } from "@/components/body-sites/body-sites-section";
import type { BodySiteSide } from "@/hooks/use-body-sites";
import { parseCheckupsView } from "@/lib/encounters/visit-links";
import { useTranslations } from "@/lib/i18n/context";
import { invalidateKeys, queryKeys } from "@/lib/query-keys";

/**
 * v1.17.1 — Care (preventive-care) reminders page. The dedicated
 * feature surface for "wann muss ich was wo machen". Auth-gated; the
 * section component owns the list + create flow.
 *
 * v1.18.1 — pull-to-refresh parity with every peer page (labs, mood,
 * measurements): a pull invalidates the measurement-reminders read so the
 * list + server-computed next-due repaint.
 *
 * The page now holds two things, split by a segmented control rather than by a
 * second nav entry: the preventive-care list, and the visits. They answer the
 * same question from two directions — what do I still have to arrange, and what
 * did I actually attend — and the page's own sentence already covers both. A
 * visit carries no module gate for the same reason this page never had one.
 *
 * v1.39.1 — a third tab, the procedure and surgery history. It is the visits
 * list read one way (the visits of kind PROCEDURE, searchable by body site),
 * so it sits beside the visits rather than behind a nav entry of its own, and
 * its read hangs off the same `["encounters"]` root the pull already evicts.
 *
 * v1.39.2 — a fourth tab, the body-site view: procedures and conditions by
 * where on the body they are, with what is linked to them. It starts from the
 * visits (a procedure is one), so it sits here rather than under the illness
 * journal, and its read hangs off the same `["encounters"]` root.
 *
 * Each view's header stands above the view switch, not under it: the page
 * reads title first, then the choice of view (`header-slot.tsx`).
 *
 * The pull invalidates both reads. Refreshing one and leaving the other stale
 * is how a page ends up showing a visit that closed a checkup still listed as
 * due.
 */
export default function CarePageClient() {
  const { isAuthenticated, isLoading } = useAuth();
  const mounted = useMounted();
  const queryClient = useQueryClient();
  const { t } = useTranslations();
  // A link to one visit (`?visit=<id>`, from a document's link chip) lands on
  // the visits tab, where the section opens it.
  const searchParams = useSearchParams();
  const linkedVisit = searchParams?.get("visit");
  // A link to one body site (`?site=<text>&side=<LEFT|RIGHT|BOTH>`, from a
  // condition's page) lands on the body-site tab with that site picked.
  const linkedSite = searchParams?.get("site")?.trim() || null;
  const linkedSideParam = searchParams?.get("side");
  const linkedSide: BodySiteSide =
    linkedSideParam === "LEFT" ||
    linkedSideParam === "RIGHT" ||
    linkedSideParam === "BOTH"
      ? linkedSideParam
      : null;
  // A link to one tab (`?view=visits`, from a line naming several
  // appointments). Built by `src/lib/encounters/visit-links.ts`, never by hand.
  const linkedView = parseCheckupsView(searchParams?.get("view"));
  const [view, setView] = useState<string>(
    linkedVisit
      ? "visits"
      : linkedSite
        ? "body-sites"
        : (linkedView ?? "vorsorge"),
  );
  // A link to a visit can arrive while the page is already open (the search
  // opens one from wherever the person is): it moves to the visits tab then
  // too, rather than only on the first render. A link to a tab does the same.
  const [observedVisit, setObservedVisit] = useState(linkedVisit);
  if (linkedVisit !== observedVisit) {
    setObservedVisit(linkedVisit);
    if (linkedVisit) setView("visits");
  }
  const [observedView, setObservedView] = useState(linkedView);
  if (linkedView !== observedView) {
    setObservedView(linkedView);
    if (linkedView && !linkedVisit) setView(linkedView);
  }

  const refresh = useCallback(
    () =>
      invalidateKeys(queryClient, [
        queryKeys.measurementReminders(),
        queryKeys.encounters(),
      ]),
    [queryClient],
  );
  const pull = usePullToRefresh({ onRefresh: refresh });
  // The active view's header (its H1, sentence and actions) lands here,
  // above the view switch; see `header-slot.tsx`.
  const [headerSlot, setHeaderSlot] = useState<HTMLDivElement | null>(null);

  if (!mounted || isLoading) {
    return <PageAuthGate />;
  }

  return (
    <div className="space-y-6">
      <PullToRefreshIndicator {...pull} />
      <div ref={setHeaderSlot} data-slot="checkups-view-header" />
      <HeaderSlotProvider value={headerSlot}>
        <Tabs value={view} onValueChange={setView}>
          <TabsList aria-label={t("checkups.viewSwitchLabel")}>
            <TabsTrigger value="vorsorge" data-testid="checkups-tab-vorsorge">
              {t("checkups.tabVorsorge")}
            </TabsTrigger>
            <TabsTrigger value="visits" data-testid="checkups-tab-visits">
              {t("checkups.tabVisits")}
            </TabsTrigger>
            <TabsTrigger
              value="procedures"
              data-testid="checkups-tab-procedures"
            >
              {t("checkups.tabProcedures")}
            </TabsTrigger>
            <TabsTrigger
              value="body-sites"
              data-testid="checkups-tab-body-sites"
            >
              {t("checkups.tabBodySites")}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="vorsorge">
            <VorsorgeSection enabled={isAuthenticated} variant="page" />
          </TabsContent>
          <TabsContent value="visits">
            {/* Mounted only on the active tab, so the visits read does not fire
              for a person who never opens it. */}
            <VisitsSection enabled={isAuthenticated} />
          </TabsContent>
          <TabsContent value="procedures">
            <ProceduresSection enabled={isAuthenticated} />
          </TabsContent>
          <TabsContent value="body-sites">
            <BodySitesSection
              enabled={isAuthenticated}
              initialSite={linkedSite}
              initialSide={linkedSide}
            />
          </TabsContent>
        </Tabs>
      </HeaderSlotProvider>
    </div>
  );
}
