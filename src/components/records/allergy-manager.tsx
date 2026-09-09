"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, ShieldAlert } from "lucide-react";
import { toast } from "sonner";

import { DeleteButton } from "@/components/data-list";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { apiDelete, apiGet } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

import { AllergyForm } from "./allergy-form";
import type { AllergyDTO } from "@/lib/records/dto";

/**
 * v1.25 (W-RECORDS) — the structured allergy/intolerance manager. Renders in
 * the Settings → Anamnese section: a list of records with add / edit / delete.
 * Patient-reported reference data, not a clinical diagnosis.
 */
export function AllergyManager() {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<AllergyDTO | null>(null);
  const [formFooterEl, setFormFooterEl] = useState<HTMLDivElement | null>(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: queryKeys.allergyList(true),
    queryFn: () => apiGet<AllergyDTO[]>("/api/allergies"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiDelete(`/api/allergies/${id}`),
    onSuccess: () => {
      toast.success(t("records.allergies.deletedToast"));
      queryClient.invalidateQueries({ queryKey: queryKeys.allergies() });
    },
    onError: () => toast.error(t("records.allergies.deleteError")),
  });

  function openNew() {
    setEditing(null);
    setFormOpen(true);
  }

  function openEdit(row: AllergyDTO) {
    setEditing(row);
    setFormOpen(true);
  }

  function afterSave() {
    setFormOpen(false);
    setEditing(null);
    queryClient.invalidateQueries({ queryKey: queryKeys.allergies() });
  }

  const rows = data ?? [];

  function renderRow(row: AllergyDTO) {
    const detail = [
      t(`records.allergies.category.${row.category}`),
      row.severity ? t(`records.allergies.severity.${row.severity}`) : null,
      row.reaction,
    ]
      .filter(Boolean)
      .join(" · ");
    return (
      <li
        key={row.id}
        className="border-border bg-background/30 flex min-h-12 items-center gap-2 rounded-md border px-3 py-2"
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="truncate text-sm font-medium">
              {row.substance}
            </span>
            {row.type === "INTOLERANCE" ? (
              <Badge variant="secondary" className="text-xs">
                {t("records.allergies.type.INTOLERANCE")}
              </Badge>
            ) : null}
            {row.status !== "ACTIVE" ? (
              <Badge variant="outline" className="text-xs">
                {t(`records.allergies.status.${row.status}`)}
              </Badge>
            ) : null}
          </div>
          {detail ? (
            <p className="text-muted-foreground truncate text-xs">{detail}</p>
          ) : null}
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
          title={t("records.allergies.deleteConfirmTitle")}
          description={t("records.allergies.deleteConfirmDescription")}
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
          {t("records.allergies.description")}
        </p>
        {rows.length > 0 ? (
          <Button size="sm" onClick={openNew} className="shrink-0">
            <Plus className="h-4 w-4" />
            {t("records.allergies.add")}
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
          title={t("records.allergies.loadError")}
          onRetry={() => void refetch()}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<ShieldAlert className="size-6" />}
          title={t("records.allergies.emptyTitle")}
          description={t("records.allergies.emptyDescription")}
          action={
            <Button onClick={openNew}>{t("records.allergies.addFirst")}</Button>
          }
        />
      ) : (
        <ul className="space-y-2">{rows.map(renderRow)}</ul>
      )}

      <ResponsiveSheet
        open={formOpen}
        onOpenChange={setFormOpen}
        title={
          editing
            ? t("records.allergies.editTitle")
            : t("records.allergies.addTitle")
        }
        description={t("records.allergies.formDescription")}
        footer={
          <div
            ref={setFormFooterEl}
            className="flex w-full justify-end gap-2"
          />
        }
      >
        <AllergyForm
          existing={editing ?? undefined}
          footerSlot={formFooterEl}
          onSuccess={afterSave}
          onCancel={() => setFormOpen(false)}
        />
      </ResponsiveSheet>
    </div>
  );
}
