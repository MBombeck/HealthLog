"use client";

import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";

import { useAuth } from "@/hooks/use-auth";
import { useMounted } from "@/hooks/use-mounted";
import { usePullToRefresh } from "@/hooks/use-pull-to-refresh";
import { PullToRefreshIndicator } from "@/components/ui/pull-to-refresh-indicator";
import { PageAuthGate } from "@/components/ui/page-auth-gate";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { VorsorgeSection } from "@/components/measurement-reminders/vorsorge-section";
import { VisitsSection } from "@/components/encounters/visits-section";
import { useTranslations } from "@/lib/i18n/context";
import { invalidateKeys, queryKeys } from "@/lib/query-keys";

/**
 * v1.17.1 — Checkups (preventive-care) reminders page. The dedicated
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
 * The pull invalidates both reads. Refreshing one and leaving the other stale
 * is how a page ends up showing a visit that closed a checkup still listed as
 * due.
 */
export default function CheckupsPageClient() {
  const { isAuthenticated, isLoading } = useAuth();
  const mounted = useMounted();
  const queryClient = useQueryClient();
  const { t } = useTranslations();
  // A link to one visit (`?visit=<id>`, from a document's link chip) lands on
  // the visits tab, where the section opens it.
  const linkedVisit = useSearchParams()?.get("visit");
  const [view, setView] = useState(linkedVisit ? "visits" : "vorsorge");

  const refresh = useCallback(
    () =>
      invalidateKeys(queryClient, [
        queryKeys.measurementReminders(),
        queryKeys.encounters(),
      ]),
    [queryClient],
  );
  const pull = usePullToRefresh({ onRefresh: refresh });

  if (!mounted || isLoading) {
    return <PageAuthGate />;
  }

  return (
    <div className="space-y-6">
      <PullToRefreshIndicator {...pull} />
      <Tabs value={view} onValueChange={setView}>
        <TabsList aria-label={t("checkups.viewSwitchLabel")}>
          <TabsTrigger value="vorsorge" data-testid="checkups-tab-vorsorge">
            {t("checkups.tabVorsorge")}
          </TabsTrigger>
          <TabsTrigger value="visits" data-testid="checkups-tab-visits">
            {t("checkups.tabVisits")}
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
      </Tabs>
    </div>
  );
}
