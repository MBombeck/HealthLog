"use client";

/**
 * v1.11.2 — Settings → AI "What the Coach remembers" panel.
 *
 * Surfaces the durable `CoachFact` rows the assistant has stored about
 * the user (the v1.11.1 routes already ship the data), grouped by
 * category, each with a relative "learned <when>" stamp and a "forget"
 * control. A bulk "forget everything" action clears the lot.
 *
 *   GET    /api/insights/coach/facts        → { data: { facts: [...] } }
 *   DELETE /api/insights/coach/facts/{id}   → { data: { deleted } }
 *   DELETE /api/insights/coach/facts        → { data: { cleared } }
 *
 * Reads unwrap `(await res.json()).data` per the envelope convention;
 * every read/write routes its key through `queryKeys.coachFacts()` so
 * a forget invalidates the list.
 *
 * v1.41 — the Coach's one memory. Each entry says where it came from
 * ("from you" for what the person asked it to keep, "from the Coach" for what
 * it kept or worked out itself), and can be edited in place
 * (`PATCH /api/insights/coach/facts/{id}`) as well as forgotten. The Coach's
 * quick settings link here (`#coach-memory`).
 *
 * v1.39 — never gated on the Coach. What the Coach stored is the person's
 * own record: it stays readable and deletable while the Coach is off for any
 * reason (the operator's switch, Hide Coach, no provider, no consent). The
 * facts routes are data routes and ask no AI gate. The same holds for the
 * stored reminders (`<CoachRemindersSection>`). Settings → Coach always
 * shows this card; while that page is not reachable, Settings → AI shows it
 * through `<StoredCoachMemory>` below, whenever rows exist.
 */
import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Brain, Loader2, Pencil, Trash2 } from "lucide-react";

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
import { Button } from "@/components/ui/button";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { EmptyState } from "@/components/ui/empty-state";
import { formatDateOrRelative } from "@/lib/format";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { toast } from "sonner";
import { apiDelete } from "@/lib/api/api-fetch";
import { Textarea } from "@/components/ui/textarea";
import {
  COACH_MEMORY_LIST_KEYS,
  REMEMBER_FACT_MAX_CHARS,
} from "@/lib/ai/coach/memory/shared";
import {
  useCoachFacts,
  useEditCoachFact,
  useForgetCoachFact,
  type CoachFactDTO,
} from "@/components/insights/coach-panel/use-coach-facts";
import { CoachConversationsMemoryCard } from "@/components/settings/coach-conversations-memory-card";
import { CoachRemindersSection } from "@/components/settings/coach-reminders-section";
import { CoachPlansMemoryCard } from "@/components/settings/coach-plans-memory-card";

/**
 * The categories in the order the list shows them: goals first, then how the
 * person likes things, then health, then the rest.
 */
const FACT_CATEGORIES = [
  "goal",
  "preference",
  "condition",
  "medication",
  "constraint",
  "context",
] as const;
type FactCategory = (typeof FACT_CATEGORIES)[number];

const CATEGORY_LABEL_KEY: Record<FactCategory, string> = {
  goal: "settings.ai.coachMemory.categoryGoal",
  preference: "settings.ai.coachMemory.categoryPreference",
  condition: "settings.ai.coachMemory.categoryCondition",
  medication: COACH_MEMORY_LIST_KEYS.categoryMedication,
  constraint: "settings.ai.coachMemory.categoryConstraint",
  context: "settings.ai.coachMemory.categoryContext",
};

/** "from you" for what the person asked to keep; everything else the Coach. */
export function factSourceKey(
  fact: Pick<CoachFactDTO, "source">,
): string | null {
  if (!fact.source) return null;
  return fact.source === "user"
    ? COACH_MEMORY_LIST_KEYS.sourceUser
    : COACH_MEMORY_LIST_KEYS.sourceCoach;
}

/** One entry, read or being edited. */
function FactRow({
  fact,
  isAuthenticated,
  forgetting,
  onForget,
}: {
  fact: CoachFactDTO;
  isAuthenticated: boolean;
  forgetting: boolean;
  onForget: () => void;
}) {
  const { t } = useTranslations();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(fact.text);
  const edit = useEditCoachFact({
    // The edited words in place are the confirmation.
    onSuccess: () => setEditing(false),
    onError: () => toast.error(t("admin.settingsSaveError")),
  });
  const sourceKey = factSourceKey(fact);
  const trimmed = draft.trim();
  const inputId = `coach-memory-edit-${fact.id}`;
  return (
    <li
      data-testid="settings-coach-memory-fact"
      data-source={fact.source}
      className="border-border bg-background flex flex-col gap-2 rounded-lg border p-3"
    >
      {editing ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (trimmed && trimmed !== fact.text) {
              edit.mutate({ id: fact.id, fact: trimmed });
            } else {
              setEditing(false);
            }
          }}
        >
          <label htmlFor={inputId} className="sr-only">
            {t(COACH_MEMORY_LIST_KEYS.edit)}
          </label>
          <Textarea
            id={inputId}
            data-slot="settings-coach-memory-edit-input"
            value={draft}
            maxLength={REMEMBER_FACT_MAX_CHARS}
            rows={2}
            onChange={(e) => setDraft(e.target.value)}
            className="text-sm"
          />
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-11 sm:min-h-9"
              onClick={() => {
                setDraft(fact.text);
                setEditing(false);
              }}
            >
              {t("settings.ai.coachMemory.cancel")}
            </Button>
            <Button
              type="submit"
              size="sm"
              className="min-h-11 sm:min-h-9"
              data-slot="settings-coach-memory-edit-save"
              disabled={!trimmed || edit.isPending}
            >
              {edit.isPending ? (
                <Loader2
                  className="size-3.5 animate-spin motion-reduce:animate-none"
                  aria-hidden
                />
              ) : null}
              {t("settings.ai.saveCta")}
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm break-words">{fact.text}</p>
            <p className="text-muted-foreground mt-1 text-xs">
              {t("settings.ai.coachMemory.learnedPrefix", {
                when: formatDateOrRelative(fact.createdAt, t),
              })}
              {sourceKey ? (
                <span data-slot="settings-coach-memory-source">
                  <span aria-hidden="true"> · </span>
                  <span className="sr-only">, </span>
                  {t(sourceKey)}
                </span>
              ) : null}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              data-slot="settings-coach-memory-edit"
              aria-label={t(COACH_MEMORY_LIST_KEYS.edit)}
              title={t(COACH_MEMORY_LIST_KEYS.edit)}
              disabled={!isAuthenticated}
              className="size-11 sm:size-9"
              onClick={() => {
                setDraft(fact.text);
                setEditing(true);
              }}
            >
              <Pencil className="size-4" aria-hidden />
            </Button>
            {/* Two icons of one size: a labelled Forget beside the icon-only
                edit squeezed the entry to three lines at 390 px. The
                accessible name and the confirmation carry the words. */}
            <ConfirmButton
              slot="settings-coach-memory-forget"
              variant="ghost"
              size="icon"
              className="size-11 sm:size-9"
              ariaLabel={t("settings.ai.coachMemory.forgetAria")}
              icon={<Trash2 className="size-4" aria-hidden />}
              label=""
              title={t("settings.ai.coachMemory.forgetTitle")}
              body={t("settings.ai.coachMemory.forgetBody")}
              confirmLabel={t("settings.ai.coachMemory.forgetConfirm")}
              disabled={!isAuthenticated}
              pending={forgetting}
              onConfirm={onForget}
            />
          </div>
        </div>
      )}
    </li>
  );
}

export function CoachMemorySection({
  isAuthenticated,
  hideWhenEmpty = false,
}: {
  isAuthenticated: boolean;
  /** Render nothing while there are no stored facts (the Coach-off mount). */
  hideWhenEmpty?: boolean;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();

  const query = useCoachFacts({ enabled: isAuthenticated });

  const forgetOne = useForgetCoachFact({
    onSuccess: () => toast.success(t("settings.ai.coachMemory.forgotToast")),
    onError: () => toast.error(t("settings.ai.coachMemory.forgotError")),
  });

  const forgetAll = useMutation({
    mutationKey: queryKeys.coachFacts(),
    mutationFn: async () => {
      const data = await apiDelete<{ cleared?: number } | undefined>(
        "/api/insights/coach/facts",
      );
      return data?.cleared ?? 0;
    },
    onSuccess: (cleared) => {
      toast.success(
        t("settings.ai.coachMemory.clearedToast", { count: cleared }),
      );
      queryClient.invalidateQueries({ queryKey: queryKeys.coachFacts() });
    },
    onError: () => {
      toast.error(t("settings.ai.coachMemory.clearError"));
    },
  });

  const facts = useMemo(() => query.data ?? [], [query.data]);

  // Group by category in the canonical category order so the panel
  // reads the same way every render regardless of insertion order.
  const grouped = useMemo(() => {
    // A category the list does not know (an older extraction's) reads as
    // context rather than vanishing.
    const known = new Set<string>(FACT_CATEGORIES);
    return FACT_CATEGORIES.map((category) => ({
      category,
      items: facts.filter((f) =>
        known.has(f.category)
          ? f.category === category
          : category === "context",
      ),
    })).filter((g) => g.items.length > 0);
  }, [facts]);

  if (hideWhenEmpty && (query.isPending || query.isError)) return null;
  if (hideWhenEmpty && facts.length === 0) return null;

  return (
    <SettingsCard
      as="section"
      id="coach-memory"
      className="scroll-mt-28"
      aria-labelledby="settings-ai-coach-memory-title"
      data-testid="settings-coach-memory-card"
    >
      <SettingsCardHeader
        icon={Brain}
        titleId="settings-ai-coach-memory-title"
        title={t("settings.ai.coachMemory.title")}
        description={t("settings.ai.coachMemory.description")}
      />
      <p className="text-sm">{t("settings.ai.coachMemory.detail")}</p>

      {query.isError && (
        <QueryErrorRow
          message={t("settings.ai.coachMemory.loadError")}
          onRetry={() => query.refetch()}
        />
      )}

      {!query.isError && facts.length === 0 ? (
        <EmptyState
          data-testid="settings-coach-memory-empty"
          variant="plain"
          size="compact"
          title={t("settings.ai.coachMemory.empty")}
        />
      ) : (
        <div className="space-y-4">
          {grouped.map((group) => (
            <div key={group.category} className="space-y-2">
              <h3
                data-testid={`settings-coach-memory-group-${group.category}`}
                className="text-muted-foreground text-xs font-medium tracking-wide uppercase"
              >
                {t(CATEGORY_LABEL_KEY[group.category])}
              </h3>
              <ul className="space-y-2">
                {group.items.map((fact) => (
                  <FactRow
                    key={fact.id}
                    fact={fact}
                    isAuthenticated={isAuthenticated}
                    // Per-id pending: only the row being deleted spins.
                    forgetting={
                      forgetOne.isPending && forgetOne.variables === fact.id
                    }
                    onForget={() => forgetOne.mutate(fact.id)}
                  />
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      <p className="text-muted-foreground border-border border-t pt-3 text-xs">
        {t("settings.ai.coachMemory.summaryNote")}
      </p>
      <SettingsCardActions>
        {facts.length > 0 ? (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-h-11 sm:min-h-9"
                data-testid="settings-coach-memory-forget-all"
                disabled={!isAuthenticated || forgetAll.isPending}
              >
                {forgetAll.isPending ? (
                  <Loader2
                    className="size-4 animate-spin motion-reduce:animate-none"
                    aria-hidden
                  />
                ) : (
                  <Trash2 className="size-4" aria-hidden />
                )}
                {t("settings.ai.coachMemory.forgetAll")}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {t("settings.ai.coachMemory.forgetAllConfirmTitle")}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {t("settings.ai.coachMemory.forgetAllConfirmBody")}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>
                  {t("settings.ai.coachMemory.cancel")}
                </AlertDialogCancel>
                <AlertDialogAction
                  data-testid="settings-coach-memory-forget-all-confirm"
                  disabled={forgetAll.isPending}
                  aria-busy={forgetAll.isPending || undefined}
                  onClick={() => forgetAll.mutate()}
                >
                  {forgetAll.isPending && (
                    <Loader2 className="mr-1 size-3.5 animate-spin motion-reduce:animate-none" />
                  )}
                  {t("settings.ai.coachMemory.forgetAllConfirmAction")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : null}
      </SettingsCardActions>
    </SettingsCard>
  );
}

/**
 * Everything the Coach stored, for Settings → AI while Settings → Coach is not
 * reachable (the Coach switched off by the operator or hidden by the person).
 * Each card renders only when it has rows, so a person who never used the
 * Coach sees nothing here.
 */
export function StoredCoachMemory({
  isAuthenticated,
}: {
  isAuthenticated: boolean;
}) {
  return (
    <>
      <CoachMemorySection isAuthenticated={isAuthenticated} hideWhenEmpty />
      <CoachConversationsMemoryCard
        isAuthenticated={isAuthenticated}
        hideWhenEmpty
      />
      <CoachPlansMemoryCard isAuthenticated={isAuthenticated} />
      <CoachRemindersSection isAuthenticated={isAuthenticated} hideWhenEmpty />
    </>
  );
}
