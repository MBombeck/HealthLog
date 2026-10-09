"use client";

/**
 * v1.40 (#1041) — manage the person's own medication categories: rename,
 * hide from the picker, delete, add. Opens from the category filter on the
 * medications list. Rows follow the mood manager's archived-tag row anatomy;
 * the delete confirmation names how many medications move to Other.
 */
import { Eye, EyeOff, Loader2, Pencil, Tag, Trash2 } from "lucide-react";
import { useState } from "react";
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
import { Input } from "@/components/ui/input";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { useTranslations } from "@/lib/i18n/context";

import { AddMedicationCategoryRow } from "./medication-category-add-row";
import {
  type MedicationCategoryLabelDTO,
  useDeleteMedicationCategory,
  useMedicationCategories,
  useUpdateMedicationCategory,
} from "./use-medication-categories";

function CategoryRow({
  category,
  onDelete,
}: {
  category: MedicationCategoryLabelDTO;
  onDelete: (category: MedicationCategoryLabelDTO) => void;
}) {
  const { t } = useTranslations();
  const update = useUpdateMedicationCategory();
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(category.label);

  async function rename() {
    const trimmed = label.trim();
    if (!trimmed || trimmed === category.label) {
      setEditing(false);
      return;
    }
    try {
      await update.mutateAsync({ key: category.key, label: trimmed });
      setEditing(false);
    } catch {
      toast.error(t("medications.category.custom.saveFailed"));
    }
  }

  async function toggleHidden() {
    try {
      await update.mutateAsync({
        key: category.key,
        isActive: !category.isActive,
      });
    } catch {
      toast.error(t("medications.category.custom.saveFailed"));
    }
  }

  if (editing) {
    return (
      <div
        className="border-border space-y-2 rounded-md border p-3"
        data-slot="medication-category-rename"
      >
        <Input
          value={label}
          maxLength={40}
          autoFocus
          aria-label={t("medications.category.custom.label")}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void rename();
            }
          }}
        />
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-h-11 sm:min-h-9"
            onClick={() => {
              setLabel(category.label);
              setEditing(false);
            }}
          >
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            size="sm"
            className="min-h-11 sm:min-h-9"
            disabled={!label.trim() || update.isPending}
            onClick={() => void rename()}
          >
            {update.isPending ? (
              <Loader2
                className="size-3.5 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : null}
            {t("common.save")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div
      data-slot="medication-category-row"
      data-key={category.key}
      className="border-border flex min-h-12 items-center gap-2 rounded-md border px-3 py-2"
    >
      <Tag
        className="text-muted-foreground size-4 shrink-0"
        aria-hidden="true"
      />
      {/* Label on its own line with the count and the hidden state under
          it, the course list's row anatomy: three 44 px actions leave a
          390 px row too little width to share with a meta column. */}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm" title={category.label}>
          {category.label}
        </p>
        <p className="text-muted-foreground text-xs tabular-nums">
          {category.isActive
            ? t("medications.category.custom.count", {
                count: String(category.medicationCount),
              })
            : `${t("medications.category.custom.count", {
                count: String(category.medicationCount),
              })}, ${t("medications.category.custom.hidden")}`}
        </p>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-11 sm:size-9"
        onClick={() => setEditing(true)}
        aria-label={`${t("medications.category.custom.rename")}: ${category.label}`}
        title={t("medications.category.custom.rename")}
      >
        <Pencil className="size-4" aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-11 sm:size-9"
        disabled={update.isPending}
        onClick={() => void toggleHidden()}
        aria-label={`${
          category.isActive
            ? t("medications.category.custom.hide")
            : t("medications.category.custom.show")
        }: ${category.label}`}
        title={
          category.isActive
            ? t("medications.category.custom.hide")
            : t("medications.category.custom.show")
        }
      >
        {category.isActive ? (
          <EyeOff className="size-4" aria-hidden="true" />
        ) : (
          <Eye className="size-4" aria-hidden="true" />
        )}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="text-muted-foreground hover:text-foreground size-11 sm:size-9"
        onClick={() => onDelete(category)}
        aria-label={`${t("medications.category.custom.delete")}: ${category.label}`}
        title={t("medications.category.custom.delete")}
      >
        <Trash2 className="size-4" aria-hidden="true" />
      </Button>
    </div>
  );
}

export function MedicationCategoriesSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslations();
  const categories = useMedicationCategories();
  const remove = useDeleteMedicationCategory();
  const [pendingDelete, setPendingDelete] =
    useState<MedicationCategoryLabelDTO | null>(null);

  async function confirmDelete(category: MedicationCategoryLabelDTO) {
    try {
      const result = await remove.mutateAsync(category.key);
      toast.success(
        t("medications.category.custom.movedToOther", {
          count: String(result.movedCount),
        }),
      );
    } catch {
      toast.error(t("medications.category.custom.saveFailed"));
    }
  }

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t("medications.category.custom.manage")}
      description={t("medications.category.custom.manageDescription")}
    >
      <div className="space-y-2" data-slot="medication-categories-sheet">
        {categories.isError ? (
          <QueryErrorRow onRetry={() => void categories.refetch()} />
        ) : (
          (categories.data ?? []).map((category) => (
            <CategoryRow
              key={category.key}
              category={category}
              onDelete={setPendingDelete}
            />
          ))
        )}
        <AddMedicationCategoryRow />
        <p className="text-muted-foreground text-xs">
          {t("medications.category.custom.bpGateNote")}
        </p>
      </div>

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(next) => {
          if (!next) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("medications.category.custom.deleteTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("medications.category.custom.deleteBody", {
                count: String(pendingDelete?.medicationCount ?? 0),
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const category = pendingDelete;
                setPendingDelete(null);
                if (category) void confirmDelete(category);
              }}
            >
              {t("medications.category.custom.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ResponsiveSheet>
  );
}
