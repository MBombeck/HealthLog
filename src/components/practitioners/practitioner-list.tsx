"use client";

/**
 * The account's own address book of doctors and practices.
 *
 * **Record content, not configuration**, so it does not live in Settings: a
 * settings surface configures behaviour, and a list of one's own doctors
 * configures nothing. It sits beside the visits that name it.
 *
 * Deleting is a soft delete and the visits that referenced the entry keep it.
 * The confirmation says so in one sentence, because a person deleting a doctor
 * has every reason to fear their history goes with it.
 */
import { ContactRound, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { Skeleton } from "@/components/ui/skeleton";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import {
  usePractitionerMutations,
  usePractitioners,
  type Practitioner,
} from "@/hooks/use-practitioners";
import { useTranslations } from "@/lib/i18n/context";
import { PractitionerSheet } from "./practitioner-sheet";

export function PractitionerList({ enabled = true }: { enabled?: boolean }) {
  const { t } = useTranslations();
  const { canWriteDomain, canManageDomain } = useRecordCapabilities();
  // `POST /api/practitioners` answers at WRITE; editing and deleting at MANAGE.
  const canAddPractitioner = canWriteDomain("profile");
  const canManageProfile = canManageDomain("profile");
  const [term, setTerm] = useState("");
  const debounced = useDebouncedValue(term, 250);
  const list = usePractitioners(debounced, enabled);
  const { remove } = usePractitionerMutations();

  const [editing, setEditing] = useState<Practitioner | "new" | null>(null);
  const [deleting, setDeleting] = useState<Practitioner | null>(null);
  // Bumped on every open so the sheet remounts with a fresh draft rather than
  // copying props into state from an effect.
  const [session, setSession] = useState(0);
  const openSheet = (target: Practitioner | "new") => {
    setEditing(target);
    setSession((n) => n + 1);
  };

  const rows = useMemo(() => list.data ?? [], [list.data]);

  // Group the flat list by specialty so a long address book reads by field
  // ("Zahnmedizin", "Hausarzt", …) instead of one undifferentiated column.
  // Specialty is exact free-text: each distinct string is its own group,
  // named groups sorted alphabetically, the unspecified rows collected into
  // one group that always sits last. When nothing carries a specialty the
  // headers are suppressed — a lone "no specialty" heading over every row is
  // noise, so the list degrades to the flat form it had before.
  const groups = useMemo(() => {
    const bySpecialty = new Map<string | null, Practitioner[]>();
    for (const row of rows) {
      const key = row.specialty?.trim() ? row.specialty.trim() : null;
      const bucket = bySpecialty.get(key);
      if (bucket) bucket.push(row);
      else bySpecialty.set(key, [row]);
    }
    const named = [...bySpecialty.entries()]
      .filter((entry): entry is [string, Practitioner[]] => entry[0] !== null)
      .sort((a, b) => a[0].localeCompare(b[0]));
    const unspecified = bySpecialty.get(null);
    return unspecified
      ? [...named, [null, unspecified] as [null, Practitioner[]]]
      : named;
  }, [rows]);
  const showGroupHeadings = groups.some(([specialty]) => specialty !== null);

  const addButton = canAddPractitioner ? (
    <Button
      type="button"
      className="min-h-11"
      data-slot="practitioner-add"
      onClick={() => openSheet("new")}
    >
      <Plus className="size-4" aria-hidden />
      {t("practitioners.add")}
    </Button>
  ) : null;

  return (
    <section className="space-y-4">
      <PageHeader
        title={t("practitioners.title")}
        description={t("practitioners.description")}
        backLink={{ href: "/checkups", label: t("encounters.sectionTitle") }}
        actions={addButton}
      />

      <div className="relative">
        <Search
          className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
          aria-hidden
        />
        <Input
          type="search"
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          placeholder={t("practitioners.searchPlaceholder")}
          aria-label={t("practitioners.searchPlaceholder")}
          className="pl-9"
          data-slot="practitioner-search"
        />
      </div>

      {list.isError ? (
        <QueryErrorCard
          title={t("practitioners.loadError")}
          onRetry={() => void list.refetch()}
        />
      ) : list.isPending ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton key={index} className="h-16 w-full rounded-xl" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<ContactRound className="size-6" aria-hidden />}
          title={t(
            debounced
              ? "practitioners.noMatchTitle"
              : "practitioners.emptyTitle",
          )}
          description={t(
            debounced
              ? "practitioners.noMatchDescription"
              : "practitioners.emptyDescription",
          )}
          action={debounced ? undefined : (addButton ?? undefined)}
          ctaSize="lg"
        />
      ) : (
        <div className="space-y-4" data-slot="practitioner-list">
          {groups.map(([specialty, groupRows]) => (
            <div key={specialty ?? "__unspecified__"} className="space-y-2">
              {showGroupHeadings ? (
                <h2
                  className="text-muted-foreground px-1 text-xs font-medium"
                  data-slot="practitioner-group-heading"
                  data-specialty={specialty ?? ""}
                >
                  {specialty ?? t("practitioners.noSpecialtyGroup")}
                </h2>
              ) : null}
              <ul className="space-y-2">
                {groupRows.map((row) => (
                  <li key={row.id}>
                    <Card className="gap-2 py-3 md:py-4">
                      <CardContent className="flex items-center gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="text-foreground truncate text-sm font-medium">
                            {row.name}
                          </p>
                          {row.practice || row.specialty ? (
                            <p className="text-foreground truncate text-sm">
                              {[row.practice, row.specialty]
                                .filter(Boolean)
                                .join(" · ")}
                            </p>
                          ) : null}
                          {row.location ? (
                            <p className="text-muted-foreground truncate text-xs">
                              {row.location}
                            </p>
                          ) : null}
                        </div>
                        {canManageProfile ? (
                          <div className="flex shrink-0 items-center gap-1">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="size-11"
                              aria-label={t("common.edit")}
                              onClick={() => openSheet(row)}
                            >
                              <Pencil className="size-4" aria-hidden />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="size-11"
                              aria-label={t("common.delete")}
                              onClick={() => setDeleting(row)}
                            >
                              <Trash2 className="size-4" aria-hidden />
                            </Button>
                          </div>
                        ) : null}
                      </CardContent>
                    </Card>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      <PractitionerSheet
        key={session}
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        practitioner={editing === "new" ? null : editing}
      />

      <AlertDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("practitioners.deleteTitle")}
            </AlertDialogTitle>
            {/* The one sentence that matters: the old visits stay. */}
            <AlertDialogDescription>
              {t("practitioners.deleteDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (!deleting) return;
                const id = deleting.id;
                setDeleting(null);
                remove.mutate(id, {
                  onError: () => toast.error(t("practitioners.deleteFailed")),
                });
              }}
            >
              {t("common.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
