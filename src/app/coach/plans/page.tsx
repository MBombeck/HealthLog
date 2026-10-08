"use client";

import { useMemo } from "react";
import Link from "next/link";
import {
  Check,
  Loader2,
  MessagesSquare,
  Target,
  Trash2,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { PageHeader } from "@/components/ui/page-header";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { COACH_SCROLLBAR } from "@/components/insights/coach-panel/message-thread";
import {
  useCoachPlans,
  useCoachPlanMutations,
  type CoachPlanDTO,
} from "@/hooks/use-coach-plans";
import { useAiCapabilityAnswer } from "@/hooks/use-ai-capability";
import { useTranslations } from "@/lib/i18n/context";
import { formatDateOrRelative } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * v1.27.x — the Coach plans management page (`/coach/plans`).
 *
 * The ledger for the durable goal / if-then plans the Coach proposes and the
 * user confirms — a sibling of `/coach/conversations`, reachable from the
 * composer's `+` actions menu. Three groups over one `?scope=all` read:
 *
 *   - proposed:  confirm (→ active) or decline (soft-delete)
 *   - standing:  active + review_due — mark met or end (→ abandoned)
 *   - past:      met + abandoned + reviewed — remove from the ledger
 *
 * There is deliberately NO prose editor: the extractor is the only writer of
 * plan text, and the PATCH contract only moves the lifecycle. An active plan
 * is injected into the Coach's snapshot memory (top-6, newest first), so
 * follow-up conversations recall it; a proposed or declined plan never is.
 *
 * With the Coach unavailable (for any reason) the page stays reachable and
 * turns read-only, like `/coach/conversations`: the plans are the person's
 * own record, so they can still be read and erased. Confirming or moving a
 * plan is Coach use and is not offered then (the PATCH route refuses it).
 */

type GroupId = "proposed" | "standing" | "past";

const GROUPS: Array<{ id: GroupId; labelKey: string }> = [
  { id: "proposed", labelKey: "coach.plans.groupProposed" },
  { id: "standing", labelKey: "coach.plans.groupActive" },
  { id: "past", labelKey: "coach.plans.groupPast" },
];

function groupOf(status: string): GroupId {
  if (status === "proposed") return "proposed";
  if (status === "active" || status === "review_due") return "standing";
  return "past";
}

function CoachPlansBody({ readOnly }: { readOnly: boolean }) {
  const { t } = useTranslations();
  const query = useCoachPlans({ filter: { scope: "all" } });
  const { setStatus, remove } = useCoachPlanMutations();

  const plans = useMemo(() => query.data ?? [], [query.data]);
  const groups = useMemo(() => {
    const buckets: Record<GroupId, CoachPlanDTO[]> = {
      proposed: [],
      standing: [],
      past: [],
    };
    for (const p of plans) buckets[groupOf(p.status)].push(p);
    return GROUPS.map((g) => ({ ...g, plans: buckets[g.id] })).filter(
      (g) => g.plans.length > 0,
    );
  }, [plans]);

  const pendingId =
    (setStatus.isPending && setStatus.variables?.id) ||
    (remove.isPending && remove.variables) ||
    null;

  const row = (plan: CoachPlanDTO) => {
    const busy = pendingId === plan.id;
    const group = groupOf(plan.status);
    return (
      <li
        key={plan.id}
        data-slot="coach-plan-row"
        data-status={plan.status}
        className="border-border bg-card flex flex-col gap-2 rounded-lg border p-3"
      >
        {/* Plan prose is the user's own committed intention — content tier. */}
        <p className="text-sm leading-relaxed break-words">
          {t("coach.plans.ifThen", {
            cue: plan.ifCue ?? "",
            action: plan.thenAction ?? "",
          })}
        </p>
        {plan.target ? (
          <p className="text-xs break-words">
            {t("coach.plans.targetPrefix", { target: plan.target })}
          </p>
        ) : null}
        <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <span className="uppercase">{plan.metric}</span>
          <span>{t(`coach.plans.status.${plan.status}`)}</span>
          <span>{formatDateOrRelative(plan.updatedAt, t)}</span>
          {plan.reviewDate ? (
            <span>
              {t("coach.plans.reviewPrefix", {
                when: formatDateOrRelative(plan.reviewDate, t),
              })}
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!readOnly && group === "proposed" && (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-h-9"
                disabled={busy}
                data-slot="coach-plan-accept"
                onClick={() =>
                  setStatus.mutate({ id: plan.id, status: "active" })
                }
              >
                {busy && setStatus.isPending ? (
                  <Loader2
                    className="size-3.5 animate-spin motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                ) : (
                  <Check className="size-3.5" aria-hidden="true" />
                )}
                {t("coach.plans.accept")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="min-h-9"
                disabled={busy}
                data-slot="coach-plan-decline"
                onClick={() => remove.mutate(plan.id)}
              >
                <X className="size-3.5" aria-hidden="true" />
                {t("coach.plans.decline")}
              </Button>
            </>
          )}
          {!readOnly && group === "standing" && (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-h-9"
                disabled={busy}
                data-slot="coach-plan-met"
                onClick={() => setStatus.mutate({ id: plan.id, status: "met" })}
              >
                <Check className="size-3.5" aria-hidden="true" />
                {t("coach.plans.markMet")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="min-h-9"
                disabled={busy}
                data-slot="coach-plan-abandon"
                onClick={() =>
                  setStatus.mutate({ id: plan.id, status: "abandoned" })
                }
              >
                <X className="size-3.5" aria-hidden="true" />
                {t("coach.plans.abandon")}
              </Button>
            </>
          )}
          {(readOnly || group === "past") && (
            <ConfirmButton
              slot="coach-plan-delete"
              variant="ghost"
              size="sm"
              className="min-h-9"
              icon={<Trash2 className="size-3.5" aria-hidden="true" />}
              label={t("coach.plans.remove")}
              title={t("coach.plans.removeTitle")}
              body={t("coach.plans.removeBody")}
              confirmLabel={t("coach.plans.removeConfirm")}
              disabled={busy && !remove.isPending}
              pending={remove.isPending}
              onConfirm={() => remove.mutate(plan.id)}
            />
          )}
        </div>
      </li>
    );
  };

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-screen-xl flex-col gap-4 px-4 pt-6 pb-4 md:px-6">
      <PageHeader
        title={
          <span data-slot="coach-plans-heading">{t("coach.plans.title")}</span>
        }
        description={
          readOnly
            ? t("coach.plans.readOnlyNote")
            : t("coach.plans.pageDescription")
        }
        actions={
          <Button asChild variant="outline" size="sm">
            <Link
              href="/coach/conversations"
              data-slot="coach-plans-conversations-link"
            >
              <MessagesSquare className="size-4" aria-hidden="true" />
              {t("insights.coach.historyTitle")}
            </Link>
          </Button>
        }
      />

      <div
        data-slot="coach-plans-list"
        className={cn(
          "-mx-1 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-1",
          COACH_SCROLLBAR,
        )}
      >
        {query.isError ? (
          <QueryErrorCard onRetry={() => query.refetch()} />
        ) : query.isLoading ? (
          <div
            data-slot="coach-plans-loading"
            className="flex flex-col gap-2"
            aria-hidden="true"
          >
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-16 w-full rounded-xl" />
            ))}
          </div>
        ) : groups.length === 0 ? (
          <div data-slot="coach-plans-empty">
            <EmptyState
              variant="plain"
              icon={<Target className="size-6" />}
              title={t("coach.plans.empty")}
            />
          </div>
        ) : (
          groups.map((group) => (
            <section
              key={group.id}
              data-slot="coach-plans-group"
              data-group={group.id}
              className="flex flex-col gap-1.5"
            >
              <h2 className="text-muted-foreground px-1 text-xs font-medium tracking-wide uppercase">
                {t(group.labelKey)}
              </h2>
              <ul className="flex flex-col gap-2">{group.plans.map(row)}</ul>
            </section>
          ))
        )}
      </div>
    </div>
  );
}

export default function CoachPlansPage() {
  // The `coach` capability, read only once `/me` has answered. Unavailable
  // means read-only, never a redirect.
  const coach = useAiCapabilityAnswer("coach");

  if (coach === null) return null;

  return (
    <div
      data-slot="coach-plans-page"
      // Match `/coach/conversations`' full-bleed sizing: cancel the AuthShell
      // padding and claim the viewport height below the top bar (minus the
      // mobile-only BottomNav band). The status-bar inset of an installed
      // app comes off as well, at every width: the shell takes it above
      // the top bar (`shell-safe-area`).
      className="bg-background shell-desktop:h-[calc(100dvh-4rem-env(safe-area-inset-top,0px))] -mx-4 -mt-6 -mb-20 flex h-[calc(100dvh-8rem-env(safe-area-inset-top,0px)-env(safe-area-inset-bottom,0px))] min-h-[32rem] flex-col overflow-hidden md:-mx-6"
    >
      <CoachPlansBody readOnly={!coach.available} />
    </div>
  );
}
