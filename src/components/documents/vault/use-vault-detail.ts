"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { apiGet } from "@/lib/api/api-fetch";
import { useCoachLaunch } from "@/lib/insights/coach-launch-context";
import { queryKeys } from "@/lib/query-keys";
import {
  currentUrlSearch,
  urlStateHistory,
  useUrlSearch,
  writeUrlState,
} from "@/lib/url-state";
import type { InboundDocumentDetailDto } from "@/lib/validations/inbound-documents";

import {
  CLOSE_TRAVERSAL_GRACE_MS,
  closeDocumentSelectionAfterCoachHandoff,
  coachHandoffRetainsSelection,
  DOCUMENT_QUERY_ID_PATTERN,
  documentSelectionHistoryState,
  documentSelectionHref,
  documentSelectionSurvivedClose,
} from "./selection-history";

/**
 * The detail sheet, driven by `?doc=`: a card pushes the selection, Back and
 * Forward and direct links drive the same state without remounting the
 * route, and a close consumes the pushed entry (and checks that it did).
 */
export function useVaultDetail({
  authLoading,
  moduleEnabled,
  pathname,
}: {
  authLoading: boolean;
  moduleEnabled: boolean;
  pathname: string;
}) {
  const queryClient = useQueryClient();
  const coachLaunch = useCoachLaunch();
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const handedOffDocumentRef = useRef<string | null>(null);

  // `?doc=` read live (`@/lib/url-state`): Next 16.4 adopts a pushState a
  // render after the write, and a Back pressed in between left the router's
  // copy reading "no document" on both sides, so the sheet stayed open.
  const liveParams = useUrlSearch();
  const rawDocParam = liveParams.get("doc");
  const docParam =
    rawDocParam !== null && DOCUMENT_QUERY_ID_PATTERN.test(rawDocParam)
      ? rawDocParam
      : null;
  const [observedDocParam, setObservedDocParam] = useState<string | null>(null);

  // The query is the navigation owner: direct links, browser back, and browser
  // forward all drive the same detail selection without remounting the route.
  // Wait for auth so a deep link cannot be consumed before the module gate is
  // known, and never interpolate an unvalidated id into the detail API path.
  if (!authLoading && moduleEnabled && rawDocParam !== observedDocParam) {
    setObservedDocParam(rawDocParam);
    setDetailId(docParam);
    setDetailOpen(docParam !== null);
  }

  const openDetail = useCallback(
    (id: string) => {
      const href = documentSelectionHref(pathname, currentUrlSearch(), id);
      if (href === null) return;
      handedOffDocumentRef.current = null;
      setDetailId(id);
      setDetailOpen(true);
      writeUrlState((params) => params.set("doc", id), {
        mode: "push",
        state: documentSelectionHistoryState(id),
      });
    },
    [pathname],
  );

  const handleDetailOpenChange = useCallback((open: boolean) => {
    setDetailOpen(open);
  }, []);

  const coachOwnsDocument =
    docParam !== null &&
    coachLaunch?.open === true &&
    coachLaunch.documentId === docParam;

  useEffect(() => {
    if (authLoading || !moduleEnabled) return;
    if (docParam === null) {
      handedOffDocumentRef.current = null;
      return;
    }
    if (detailOpen) return;
    if (coachOwnsDocument) {
      // "Ask Coach" intentionally closes the sheet while the drawer owns the
      // same document. Keep the return URL intact so maximize → browser-back
      // can reconstruct the sheet from `?doc=`.
      handedOffDocumentRef.current = docParam;
      return;
    }
    // Read before the call below reassigns the ref: the same inputs the close
    // itself decides on.
    const retainedAsReturnUrl = coachHandoffRetainsSelection(
      docParam,
      handedOffDocumentRef.current,
      coachLaunch?.closeIntent,
    );

    handedOffDocumentRef.current = closeDocumentSelectionAfterCoachHandoff(
      urlStateHistory,
      pathname,
      currentUrlSearch(),
      docParam,
      handedOffDocumentRef.current,
      coachLaunch?.closeIntent,
    );

    // Nothing was closed: the selection is the way back from `/coach` and is
    // meant to stay. Checking for it here would delete it.
    if (retainedAsReturnUrl) return;

    // Consuming the pushed entry is a REQUEST to the browser, not a guarantee.
    //
    // `history.back()` is queued against the session history, and a traversal
    // asked for while another is still settling can be dropped — closing the
    // sheet immediately after pressing the browser's Forward button is exactly
    // that shape. Nothing raises when it happens: the sheet is closed, React
    // is consistent, and the URL still names the document. A reload or a
    // shared link then re-opens the sheet the reader just closed.
    //
    // So the request is checked rather than trusted. If the selection is still
    // in the address bar shortly afterwards, it is removed the synchronous
    // way. The guard is the document id, so a traversal that landed on some
    // other selection is left alone, and the cleanup below cancels the check
    // the moment the sheet re-opens or the parameter changes — which is what
    // makes re-opening within the window safe.
    const verify = window.setTimeout(() => {
      if (!documentSelectionSurvivedClose(currentUrlSearch(), docParam)) {
        return;
      }
      writeUrlState((params) => params.delete("doc"));
    }, CLOSE_TRAVERSAL_GRACE_MS);
    return () => window.clearTimeout(verify);
  }, [
    authLoading,
    coachOwnsDocument,
    coachLaunch?.closeIntent,
    detailOpen,
    docParam,
    moduleEnabled,
    pathname,
  ]);

  // Hover/focus intent prefetches the detail METADATA (never the blob —
  // the blob fetch starts when the sheet mounts its preview element).
  const prefetchDetail = useCallback(
    (id: string) => {
      void queryClient.prefetchQuery({
        queryKey: queryKeys.inboundDocument(id),
        queryFn: () =>
          apiGet<InboundDocumentDetailDto>(`/api/documents/inbound/${id}`),
        staleTime: 30_000,
      });
    },
    [queryClient],
  );

  return {
    detailId,
    detailOpen,
    openDetail,
    handleDetailOpenChange,
    prefetchDetail,
  };
}
