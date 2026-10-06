"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { apiGet } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import type { InboundDocumentDto } from "@/lib/validations/inbound-documents";

import { DOCUMENT_KIND_ICONS } from "@/components/documents/document-kind-meta";

/**
 * v1.29.x (S7) — the "Choose from documents" picker for attaching stored vault
 * documents to a Coach conversation. Lists the user's live documents via the
 * existing `GET /api/documents/inbound` list and lets the user multi-select up
 * to the remaining attachment cap. Documents that are not yet content-indexed
 * render disabled with a hint (the fenced endpoint can only answer over indexed
 * text). Documents already attached / staged are excluded from the list.
 *
 * The dialog owns only its own local selection; on confirm it hands the chosen
 * ids to the parent, which performs the attach (an existing conversation) or
 * stages them as pending first-turn attachments (a not-yet-created chat).
 */
interface ListPage {
  documents: InboundDocumentDto[];
  nextCursor: string | null;
}

export interface AttachmentPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** How many more documents may be attached (MAX_COACH_ATTACHMENTS − current). */
  remainingSlots: number;
  /** Document ids already attached / staged — hidden from the list. */
  excludeIds: string[];
  onConfirm: (ids: string[]) => void;
}

export function AttachmentPicker({
  open,
  onOpenChange,
  remainingSlots,
  excludeIds,
  onConfirm,
}: AttachmentPickerProps) {
  const { t } = useTranslations();

  const [searchDraft, setSearchDraft] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);

  // Reset the transient selection + search on close so a cancelled pass never
  // leaks into the next open. Done in the close handler (not an effect) so no
  // setState-in-effect cascade fires.
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) {
        setSelected([]);
        setSearchDraft("");
        setQuery("");
      }
      onOpenChange(next);
    },
    [onOpenChange],
  );

  // 200 ms debounce, matching the vault's search feel.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    },
    [],
  );
  const onSearchChange = (value: string) => {
    setSearchDraft(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setQuery(value.trim()), 200);
  };

  const list = useQuery({
    queryKey: queryKeys.inboundDocumentPicker(query),
    enabled: open,
    queryFn: () => {
      const sp = new URLSearchParams();
      if (query) sp.set("q", query);
      sp.set("sort", "documentDate");
      sp.set("order", "desc");
      sp.set("limit", "50");
      return apiGet<ListPage>(`/api/documents/inbound?${sp.toString()}`);
    },
  });

  const excludeSet = useMemo(() => new Set(excludeIds), [excludeIds]);
  const documents = useMemo(
    () => (list.data?.documents ?? []).filter((d) => !excludeSet.has(d.id)),
    [list.data, excludeSet],
  );

  const capReached = selected.length >= remainingSlots;

  function toggle(id: string) {
    setSelected((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= remainingSlots) return prev; // honour the cap
      return [...prev, id];
    });
  }

  function handleConfirm() {
    if (selected.length === 0) return;
    onConfirm(selected);
    handleOpenChange(false);
  }

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={handleOpenChange}
      title={t("insights.coach.attach.pickerTitle")}
      description={t("insights.coach.attach.pickerDescription")}
      contentWidth="lg"
      footer={
        <>
          <Button
            type="button"
            variant="ghost"
            onClick={() => handleOpenChange(false)}
            data-slot="coach-attachment-picker-cancel"
          >
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            onClick={handleConfirm}
            disabled={selected.length === 0}
            data-slot="coach-attachment-picker-confirm"
          >
            {t("insights.coach.attach.pickerConfirm", {
              count: selected.length,
            })}
          </Button>
        </>
      }
    >
      <div data-slot="coach-attachment-picker" className="flex flex-col gap-3">
        <div className="relative">
          <Search
            className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
            aria-hidden="true"
          />
          <Input
            type="search"
            value={searchDraft}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={t("insights.coach.attach.pickerSearchPlaceholder")}
            aria-label={t("insights.coach.attach.pickerSearchPlaceholder")}
            data-slot="coach-attachment-picker-search"
            className="pl-9"
          />
        </div>

        <p
          data-slot="coach-attachment-picker-cap"
          className="text-muted-foreground text-xs"
        >
          {t("insights.coach.attach.pickerCap", { max: remainingSlots })}
        </p>

        {list.isPending && open ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-12 w-full rounded-lg" />
            ))}
          </div>
        ) : list.isError ? (
          <p role="alert" className="text-destructive text-sm">
            {t("documents.list.loadError")}
          </p>
        ) : documents.length === 0 ? (
          <p className="text-muted-foreground py-6 text-center text-sm">
            {t("insights.coach.attach.pickerEmpty")}
          </p>
        ) : (
          <ul className="max-h-[50vh] space-y-1.5 overflow-y-auto overscroll-contain">
            {documents.map((doc) => {
              const isSelected = selected.includes(doc.id);
              const selectable = doc.hasContentIndex;
              const disabled = !selectable || (!isSelected && capReached);
              const title =
                doc.title ?? doc.filename ?? t("documents.card.untitled");
              const Icon = DOCUMENT_KIND_ICONS[doc.kind];
              return (
                <li key={doc.id}>
                  <button
                    type="button"
                    aria-pressed={isSelected}
                    disabled={disabled}
                    onClick={() => selectable && toggle(doc.id)}
                    data-slot="coach-attachment-picker-item"
                    data-selected={isSelected ? "true" : undefined}
                    className={cn(
                      "border-border hover:bg-muted/50 flex w-full items-center gap-3 rounded-lg border p-3 text-left",
                      "focus-visible:ring-input-focus focus-visible:ring-[3px] focus-visible:outline-none",
                      isSelected && "border-primary/40 bg-primary/5",
                      disabled &&
                        "cursor-not-allowed opacity-60 hover:bg-transparent",
                    )}
                  >
                    <Icon
                      className="text-foreground size-5 shrink-0"
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        {title}
                      </span>
                      {!selectable ? (
                        <span className="text-muted-foreground block text-xs">
                          {t("insights.coach.attach.pickerNotIndexed")}
                        </span>
                      ) : null}
                    </span>
                    <Check
                      className={cn(
                        "text-primary size-4 shrink-0",
                        isSelected ? "opacity-100" : "opacity-0",
                      )}
                      aria-hidden="true"
                    />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </ResponsiveSheet>
  );
}
