"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { showErrorToast } from "@/lib/errors/error-toast";
import { useTranslations } from "@/lib/i18n/context";
import type { InboundDocumentDto } from "@/lib/validations/inbound-documents";

import {
  expandRangeSelection,
  resolveBulkShareDocuments,
  SHARE_LINK_MAX_DOCUMENTS,
} from "../vault-utils";

import { useVaultBulk } from "./use-vault-bulk";

/**
 * The selection (with shift-click ranges, cleared by Escape unless a dialog
 * or menu owns the key) and what can be done with it: re-file, link, share
 * as one link, and delete, which always asks first and offers one undo for
 * the whole batch.
 */
export function useVaultSelection(documents: InboundDocumentDto[]) {
  const { t } = useTranslations();
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  // Anchor for shift-click ranges: the last plainly-toggled id.
  const rangeAnchorRef = useRef<string | null>(null);
  const toggleSelected = useCallback(
    (id: string, range?: boolean) => {
      setSelectedIds((prev) => {
        if (range) {
          return expandRangeSelection(
            documents.map((d) => d.id),
            prev,
            rangeAnchorRef.current,
            id,
          );
        }
        const next = new Set(prev);
        if (next.has(id)) {
          next.delete(id);
        } else {
          next.add(id);
        }
        return next;
      });
      if (!range) rangeAnchorRef.current = id;
    },
    [documents],
  );
  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
    rangeAnchorRef.current = null;
  }, []);

  // Escape clears the selection — unless a dialog/popover owns the key.
  useEffect(() => {
    if (selectedIds.size === 0) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('[role="dialog"],[role="menu"]')) return;
      clearSelection();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedIds.size, clearSelection]);

  const { bulk, runBulk, deleteBulk } = useVaultBulk({
    selectedIds,
    clearSelection,
  });

  // ── Delete confirmation ───────────────────────────────────────────────
  // Every way of deleting from the vault page — the bulk bar's Delete and a
  // card's Delete key — comes through here and asks first. Nothing on this
  // page calls `deleteBulk` directly.
  const [pendingDeleteIds, setPendingDeleteIds] = useState<string[] | null>(
    null,
  );
  const requestDelete = useCallback((ids: string[]) => {
    if (ids.length > 0) setPendingDeleteIds(ids);
  }, []);
  const confirmDelete = useCallback(() => {
    if (pendingDeleteIds) deleteBulk(pendingDeleteIds);
    setPendingDeleteIds(null);
  }, [pendingDeleteIds, deleteBulk]);

  // ── Bulk share ────────────────────────────────────────────────────────
  // ONE documents-only link for the whole selection (the share model carries
  // up to SHARE_MAX_DOCUMENTS docs per link). The titles come from the loaded
  // corpus — a selected id is always a rendered row. Over the cap we surface a
  // hint and refuse rather than silently dropping docs from the link.
  const [bulkShareOpen, setBulkShareOpen] = useState(false);
  const [bulkShareDocs, setBulkShareDocs] = useState<
    { id: string; title: string }[]
  >([]);
  const openBulkShare = useCallback(() => {
    const resolved = resolveBulkShareDocuments(
      documents,
      selectedIds,
      t("documents.card.untitled"),
    );
    if (resolved.overCap) {
      showErrorToast(
        t("documents.bulk.shareTooMany", { max: SHARE_LINK_MAX_DOCUMENTS }),
      );
      return;
    }
    if (resolved.documents.length === 0) return;
    setBulkShareDocs(resolved.documents);
    setBulkShareOpen(true);
  }, [documents, selectedIds, t]);

  return {
    selectedIds,
    toggleSelected,
    clearSelection,
    bulk,
    runBulk,
    pendingDeleteIds,
    setPendingDeleteIds,
    requestDelete,
    confirmDelete,
    bulkShareOpen,
    setBulkShareOpen,
    bulkShareDocs,
    openBulkShare,
  };
}
