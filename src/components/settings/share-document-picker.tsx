"use client";

/**
 * Owner document picker for the clinician-share create flow. A
 * `ResponsiveSheet` (bottom sheet on phones) with a debounced search over the
 * user's own vault — the SAME recall path as the vault page — and one
 * multi-select toggle row per document. Selection is client-only state; the
 * chosen ids POST with the share link, which freezes them write-once. The set
 * is bounded at `max` (mirrors `SHARE_LINK_MAX_DOCUMENTS`): once the cap is
 * reached, unselected rows disable so the client never posts an oversized set.
 *
 * The list, search and rows are the shared `DocumentPickerSheet`. No write
 * happens here — attaching is the create mutation's job.
 */
import { DocumentPickerSheet } from "@/components/documents/document-picker-sheet";
import { useTranslations } from "@/lib/i18n/context";
import type { InboundDocumentDto } from "@/lib/validations/inbound-documents";

/** A picked document, carried by id + a display title (for the owner chips). */
export interface PickedDocument {
  id: string;
  title: string;
}

export function ShareDocumentPicker({
  open,
  onOpenChange,
  selected,
  onSelectedChange,
  max,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selected: PickedDocument[];
  onSelectedChange: (next: PickedDocument[]) => void;
  max: number;
}) {
  const { t } = useTranslations();
  const selectedIds = new Set(selected.map((s) => s.id));
  const atCap = selected.length >= max;

  function toggle(doc: InboundDocumentDto, title: string) {
    if (selectedIds.has(doc.id)) {
      onSelectedChange(selected.filter((s) => s.id !== doc.id));
      return;
    }
    if (atCap) return;
    onSelectedChange([...selected, { id: doc.id, title }]);
  }

  return (
    <DocumentPickerSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t("settings.sharing.pickerTitle")}
      description={t("settings.sharing.pickerDescription", { max })}
      searchPlaceholder={t("settings.sharing.pickerSearch")}
      emptyLabel={t("settings.sharing.pickerEmpty")}
      listTestId="share-doc-picker-list"
      isPicked={(doc) => selectedIds.has(doc.id)}
      isDisabled={(_doc, picked) => !picked && atCap}
      onToggle={(doc, title) => toggle(doc, title)}
      notice={
        atCap ? (
          <p
            className="text-warning bg-warning/10 rounded-md px-3 py-2 text-xs"
            role="status"
          >
            {t("settings.sharing.pickerMaxReached", { max })}
          </p>
        ) : (
          <p className="text-muted-foreground text-xs" aria-live="polite">
            {t("settings.sharing.pickerSelectedCount", {
              count: selected.length,
              max,
            })}
          </p>
        )
      }
    />
  );
}
