"use client";

/**
 * The procedure and surgery history — the third tab of the checkups page.
 *
 * It answers the intake-form question "what surgeries have you had" at a
 * glance, and "what was done on the left knee" with one tap. A procedure is a
 * visit of kind PROCEDURE, so there is no second record type to keep in step:
 * the rows here are the same rows the visits tab lists, opened into the same
 * sheet, and a visit filed before this view existed joins it by switching its
 * kind.
 *
 * The search runs on the server. The body site is encrypted at rest, so the
 * server decrypts the account's own procedures and matches there; this view
 * sends the words and renders the answer. The body-site choices and the total
 * come back with every answer, computed over the whole history, so picking one
 * never makes the others disappear.
 */
import { Plus, Scissors, Search } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { FieldGroup } from "@/components/ui/field-group";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { Skeleton } from "@/components/ui/skeleton";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import { useProcedures, type Encounter } from "@/hooks/use-encounters";
import { useTranslations } from "@/lib/i18n/context";
import type { BodySiteFacetDTO } from "@/lib/encounters/dto";
import { bodySiteText } from "./encounter-labels";
import { EncounterSheet } from "./encounter-sheet";
import { VisitCard } from "./visit-card";

type Side = "LEFT" | "RIGHT" | "BOTH" | null;

export function ProceduresSection({ enabled = true }: { enabled?: boolean }) {
  const { t } = useTranslations();
  const { canWriteDomain, canManageDomain } = useRecordCapabilities();
  // Same grant questions as the visits tab: a procedure is a visit.
  const canAdd = canWriteDomain("profile");
  const canManage = canManageDomain("profile");

  const [query, setQuery] = useState("");
  const [side, setSide] = useState<Side>(null);
  const q = useDebouncedValue(query.trim(), 250);
  const list = useProcedures(enabled, { q, laterality: side });

  const [editing, setEditing] = useState<Encounter | "new" | null>(null);
  const [session, setSession] = useState(0);
  const openSheet = (target: Encounter | "new") => {
    setEditing(target);
    setSession((n) => n + 1);
  };

  const procedures = list.data?.procedures ?? [];
  const bodySites = list.data?.bodySites ?? [];
  const total = list.data?.total ?? 0;
  const filtered = query.trim().length > 0 || side !== null;

  const pick = (facet: BodySiteFacetDTO | null) => {
    setQuery(facet?.bodySite ?? "");
    setSide(facet?.laterality ?? null);
  };
  const isPicked = (facet: BodySiteFacetDTO) =>
    query.trim() === facet.bodySite && side === facet.laterality;

  const addButton = canAdd ? (
    <Button
      type="button"
      className="min-h-11"
      data-slot="procedures-add"
      onClick={() => openSheet("new")}
    >
      <Plus className="size-4" aria-hidden />
      {t("encounters.procedures.add")}
    </Button>
  ) : null;

  return (
    <section aria-labelledby="procedures-section-title" className="space-y-4">
      <PageHeader
        titleId="procedures-section-title"
        title={t("encounters.procedures.title")}
        description={t("encounters.procedures.description")}
        actions={addButton}
      />

      {list.isError ? (
        <QueryErrorCard
          title={t("encounters.procedures.loadError")}
          onRetry={() => void list.refetch()}
        />
      ) : list.isPending ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton key={index} className="h-20 w-full rounded-xl" />
          ))}
        </div>
      ) : total === 0 ? (
        <EmptyState
          icon={<Scissors className="size-6" aria-hidden />}
          title={t("encounters.procedures.emptyTitle")}
          description={t("encounters.procedures.emptyDescription")}
          action={addButton ?? undefined}
          ctaSize="lg"
        />
      ) : (
        <div className="space-y-4">
          <div className="space-y-3" data-slot="procedures-filter">
            <FieldGroup
              htmlFor="procedures-search"
              label={t("encounters.procedures.searchLabel")}
            >
              <div className="relative">
                <Search
                  className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
                  aria-hidden
                />
                <Input
                  id="procedures-search"
                  type="search"
                  value={query}
                  autoComplete="off"
                  maxLength={200}
                  placeholder={t("encounters.procedures.searchPlaceholder")}
                  className="pl-9"
                  onChange={(event) => {
                    setQuery(event.target.value);
                    // Typing starts a new question; a side picked from a chip
                    // belonged to the old one.
                    setSide(null);
                  }}
                />
              </div>
            </FieldGroup>

            {bodySites.length > 0 ? (
              <div
                role="group"
                aria-label={t("encounters.procedures.sitesLabel")}
                className="flex flex-wrap gap-2"
              >
                <Button
                  type="button"
                  size="sm"
                  variant={filtered ? "outline" : "secondary"}
                  aria-pressed={!filtered}
                  data-slot="procedures-site-all"
                  className="min-h-11 rounded-full sm:min-h-9"
                  onClick={() => pick(null)}
                >
                  {t("encounters.procedures.allSites")}
                </Button>
                {bodySites.map((facet) => {
                  const picked = isPicked(facet);
                  return (
                    <Button
                      key={`${facet.bodySite}|${facet.laterality ?? ""}`}
                      type="button"
                      size="sm"
                      variant={picked ? "secondary" : "outline"}
                      aria-pressed={picked}
                      data-slot="procedures-site"
                      className="min-h-11 rounded-full sm:min-h-9"
                      onClick={() => pick(picked ? null : facet)}
                    >
                      {bodySiteText(t, facet.bodySite, facet.laterality)}
                      <span className="text-muted-foreground tabular-nums">
                        {facet.count}
                      </span>
                    </Button>
                  );
                })}
              </div>
            ) : null}
          </div>

          <p className="text-muted-foreground text-xs" aria-live="polite">
            {t("encounters.procedures.count", {
              shown: String(procedures.length),
              total: String(total),
            })}
          </p>

          {procedures.length === 0 ? (
            <EmptyState
              icon={<Search className="size-6" aria-hidden />}
              title={t("encounters.procedures.noMatchTitle")}
              action={
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  onClick={() => pick(null)}
                >
                  {t("encounters.procedures.clearFilter")}
                </Button>
              }
            />
          ) : (
            <div className="space-y-2" data-slot="procedures-list">
              {procedures.map((encounter) => (
                <VisitCard
                  key={encounter.id}
                  encounter={encounter}
                  onOpen={canManage ? openSheet : undefined}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Remounted per open, like the visits tab's sheet, so a new procedure
          starts as a procedure and an edit starts from its own row. */}
      <EncounterSheet
        key={session}
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        encounter={editing === "new" ? null : editing}
        kind="PROCEDURE"
      />
    </section>
  );
}
