"use client";

import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import {
  isRecordSurfacePartPresentable,
  type RecordSurfacePage,
  type RecordSurfacePartId,
  type RecordViewer,
} from "@/lib/sharing/record-page-surfaces";

/** The record on screen as the page-surface rules read it. */
export function useRecordViewer(): RecordViewer {
  const { inSharedRecord, recordKind, level, sections } =
    useRecordCapabilities();
  return { inSharedRecord, recordKind, level, sections };
}

/**
 * Whether one part of a page renders for the person at the keyboard: the rule
 * of the part's routes (`RECORD_PAGE_SURFACES`), evaluated on the
 * server-resolved record context. One's own record renders every part.
 */
export function useRecordSurfacePart<P extends RecordSurfacePage>(
  page: P,
  part: RecordSurfacePartId<P>,
): boolean {
  return isRecordSurfacePartPresentable(page, part, useRecordViewer());
}
