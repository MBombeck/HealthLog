"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Users } from "lucide-react";
import { toast } from "sonner";

import { DeleteButton } from "@/components/data-list";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { apiDelete, apiGet } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

import { FamilyHistoryForm } from "./family-history-form";
import type { FamilyHistoryEntryDTO } from "@/lib/records/dto";

/**
 * v1.25 (W-RECORDS) — the structured family-history manager. Renders in the
 * Settings → Anamnese section: a list of condition-by-relative records with
 * add / edit / delete. Patient-reported reference data, not a clinical
 * diagnosis.
 */
export function FamilyHistoryManager() {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<FamilyHistoryEntryDTO | null>(null);
  const [formFooterEl, setFormFooterEl] = useState<HTMLDivElement | null>(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: queryKeys.familyHistoryList(),
    queryFn: () => apiGet<FamilyHistoryEntryDTO[]>("/api/family-history"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiDelete(`/api/family-history/${id}`),
    onSuccess: () => {
      toast.success(t("records.family.deletedToast"));
      queryClient.invalidateQueries({ queryKey: queryKeys.familyHistory() });
    },
    onError: () => toast.error(t("records.family.deleteError")),
  });

  function openNew() {
    setEditing(null);
    setFormOpen(true);
  }

  function openEdit(row: FamilyHistoryEntryDTO) {
    setEditing(row);
    setFormOpen(true);
  }

  function afterSave() {
    setFormOpen(false);
    setEditing(null);
    queryClient.invalidateQueries({ queryKey: queryKeys.familyHistory() });
  }

  const rows = data ?? [];

  function renderRow(row: FamilyHistoryEntryDTO) {
    const detail = [
      t(`records.family.relationship.${row.relationship}`),
      row.ageAtOnset != null
        ? t("records.family.ageAtOnsetShort", { age: row.ageAtOnset })
        : null,
    ]
      .filter(Boolean)
      .join(" · ");
    return (
      <li
        key={row.id}
        className="border-border bg-background/30 flex min-h-12 items-center gap-2 rounded-md border px-3 py-2"
      >
        <div className="min-w-0 flex-1">
          <span className="truncate text-sm font-medium">{row.condition}</span>
          <p className="text-muted-foreground truncate text-xs">{detail}</p>
        </div>
        <Button
          size="icon"
          variant="ghost"
          className="size-11 sm:size-9"
          onClick={() => openEdit(row)}
          aria-label={t("common.edit")}
        >
          <Pencil className="h-4 w-4" />
        </Button>
        <DeleteButton
          domain="profile"
          onConfirm={() => deleteMutation.mutate(row.id)}
          title={t("records.family.deleteConfirmTitle")}
          description={t("records.family.deleteConfirmDescription")}
          confirmLabel={t("common.delete")}
          className="size-11 sm:size-9"
          iconClassName="h-4 w-4"
        />
      </li>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-muted-foreground text-sm">
          {t("records.family.description")}
        </p>
        {rows.length > 0 ? (
          <Button size="sm" onClick={openNew} className="shrink-0">
            <Plus className="h-4 w-4" />
            {t("records.family.add")}
          </Button>
        ) : null}
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 2 }, (_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : isError ? (
        <QueryErrorCard
          title={t("records.family.loadError")}
          onRetry={() => void refetch()}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Users className="size-6" />}
          title={t("records.family.emptyTitle")}
          description={t("records.family.emptyDescription")}
          action={
            <Button onClick={openNew}>{t("records.family.addFirst")}</Button>
          }
        />
      ) : (
        <ul className="space-y-2">{rows.map(renderRow)}</ul>
      )}

      <ResponsiveSheet
        open={formOpen}
        onOpenChange={setFormOpen}
        title={
          editing ? t("records.family.editTitle") : t("records.family.addTitle")
        }
        description={t("records.family.formDescription")}
        footer={
          <div
            ref={setFormFooterEl}
            className="flex w-full justify-end gap-2"
          />
        }
      >
        <FamilyHistoryForm
          existing={editing ?? undefined}
          footerSlot={formFooterEl}
          onSuccess={afterSave}
          onCancel={() => setFormOpen(false)}
        />
      </ResponsiveSheet>
    </div>
  );
}
