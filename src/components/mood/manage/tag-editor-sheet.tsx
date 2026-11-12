"use client";

import { useId, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { showErrorToast } from "@/lib/errors/error-toast";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { ApiError, apiPatch, apiPost } from "@/lib/api/api-fetch";
import { localizedApiError } from "@/lib/api/localized-error";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { MoodTagIconPicker } from "../mood-tag-icon-picker";
import {
  invalidateMoodTagCaches,
  type ManageCatalog,
  type ManageTag,
} from "./use-mood-tag-manage";

/**
 * v1.17 — create / edit sheet for a custom mood tag, shared by the
 * settings tag manager and the picker's inline "+" tile. Label (40-char
 * counter, mirrors the server Zod bound), curated icon picker, group
 * select (any seeded category or one of the caller's own groups — the
 * widened `categoryKey` contract).
 *
 * Create POSTs `/api/mood/tags/custom` and inserts the 201 DTO into the
 * picker cache immediately (so an inline create lands in the form
 * without a refetch round-trip), then invalidates the
 * `["mood-tag-catalog"]` prefix. Edit PATCHes `/custom/[key]`
 * (label / icon / categoryKey move).
 */

const LABEL_MAX_LENGTH = 40;

export interface TagEditorGroupOption {
  key: string;
  name: string;
}

export interface TagEditorSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Group choices: every category of the effective tree, display-named. */
  groups: TagEditorGroupOption[];
  /** Preselected group for create mode (inline "+" tile passes its group). */
  initialGroupKey?: string;
  /** Present → edit mode for this custom tag. */
  tag?: {
    key: string;
    label: string;
    icon: string | null;
    groupKey: string;
  };
  /** Fires with the server DTO after a successful create. */
  onCreated?: (tag: ManageTag) => void;
}

/** Append a fresh tag DTO to its group in a cached catalog tree. */
export function insertTagIntoCatalog(
  catalog: ManageCatalog,
  groupKey: string,
  tag: ManageTag,
): ManageCatalog {
  let inserted = false;
  const categories = catalog.categories.map((category) => {
    if (category.key !== groupKey) return category;
    inserted = true;
    return { ...category, tags: [...category.tags, tag] };
  });
  // The plain picker read drops empty categories, so a first tag in a
  // fresh group has no node to land in — the prefix invalidation that
  // follows fetches the tree with the group present.
  return inserted ? { categories } : catalog;
}

export function TagEditorSheet({
  open,
  onOpenChange,
  groups,
  initialGroupKey,
  tag,
  onCreated,
}: TagEditorSheetProps) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const formId = useId();
  const labelInputId = useId();
  const groupSelectId = useId();

  // Hosts mount this sheet conditionally (`{open && <TagEditorSheet …>}`),
  // so the field state seeds fresh from props on every open — no
  // re-seeding effect needed.
  const isEdit = tag !== undefined;
  const [label, setLabel] = useState(tag?.label ?? "");
  const [icon, setIcon] = useState<string | null>(tag?.icon ?? "Tag");
  const [groupKey, setGroupKey] = useState(
    tag?.groupKey ?? initialGroupKey ?? "custom",
  );
  const [saving, setSaving] = useState(false);

  const trimmed = label.trim();
  const valid = trimmed.length > 0 && trimmed.length <= LABEL_MAX_LENGTH;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid || saving) return;
    setSaving(true);
    try {
      if (isEdit) {
        await apiPatch(`/api/mood/tags/custom/${encodeURIComponent(tag.key)}`, {
          ...(trimmed !== tag.label ? { label: trimmed } : {}),
          ...(icon !== tag.icon ? { icon } : {}),
          ...(groupKey !== tag.groupKey ? { categoryKey: groupKey } : {}),
        });
        toast.success(t("common.saved"));
      } else {
        const created = await apiPost<ManageTag>("/api/mood/tags/custom", {
          label: trimmed,
          icon,
          categoryKey: groupKey,
        });
        // Land the fresh tag in the picker cache immediately so the
        // inline-create flow pre-selects it without a refetch beat.
        if (created) {
          queryClient.setQueryData<ManageCatalog>(
            queryKeys.moodTagCatalog(),
            (current) =>
              current
                ? insertTagIntoCatalog(current, groupKey, created)
                : current,
          );
          onCreated?.(created);
        }
        toast.success(t("common.saved"));
      }
      onOpenChange(false);
      void invalidateMoodTagCaches(queryClient);
    } catch (err) {
      if (err instanceof ApiError && err.status === 422) {
        showErrorToast(t("mood.manage.tagLimitReached"), { cause: err });
      } else {
        showErrorToast(localizedApiError(err, t, "common.error"), {
          cause: err,
        });
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      title={isEdit ? t("common.edit") : t("mood.manage.newTag")}
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            {t("common.cancel")}
          </Button>
          <Button type="submit" form={formId} disabled={saving || !valid}>
            {saving && (
              <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
            )}
            {t("common.save")}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        onSubmit={handleSubmit}
        className="space-y-4"
        data-slot="mood-tag-editor"
      >
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor={labelInputId}>{t("mood.manage.tagLabel")}</Label>
            <span
              className={`text-xs tabular-nums ${
                label.length >= LABEL_MAX_LENGTH
                  ? "text-destructive"
                  : "text-muted-foreground"
              }`}
              aria-live="polite"
            >
              {t("mood.noteCharCount", {
                count: String(label.length),
                max: String(LABEL_MAX_LENGTH),
              })}
            </span>
          </div>
          <Input
            id={labelInputId}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={LABEL_MAX_LENGTH}
            autoFocus
            autoComplete="off"
            autoCapitalize="sentences"
            enterKeyHint="done"
            required
            aria-required="true"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor={groupSelectId}>{t("mood.manage.tagGroup")}</Label>
          <NativeSelect
            id={groupSelectId}
            value={groupKey}
            onChange={(e) => setGroupKey(e.target.value)}
          >
            {groups.map((group) => (
              <option key={group.key} value={group.key}>
                {group.name}
              </option>
            ))}
          </NativeSelect>
        </div>

        <div className="space-y-2">
          <Label>{t("mood.manage.tagIcon")}</Label>
          <MoodTagIconPicker value={icon} onChange={setIcon} />
        </div>
      </form>
    </ResponsiveSheet>
  );
}
