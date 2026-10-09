"use client";

import {
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";

import { apiGet, apiPut } from "@/lib/api/api-fetch";
import {
  DEFAULT_DOCUMENTS_LAYOUT,
  type DocumentsLayout,
  type DocumentsLayoutArrangement,
  type DocumentsLayoutView,
} from "@/lib/documents/documents-layout";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

type Translator = (
  key: string,
  params?: Record<string, string | number>,
) => string;

type LayoutPatch = {
  view?: DocumentsLayoutView;
  arrangement?: DocumentsLayoutArrangement;
};

/**
 * Apply one field optimistically (the switch has to feel instant), then
 * persist it. The PUT is field-scoped, so a view change never resets the
 * arrangement and vice versa. On failure the cache rolls back and a calm
 * toast says so.
 */
export async function runSetDocumentsLayout(deps: {
  patch: LayoutPatch;
  queryClient: QueryClient;
  t: Translator;
}): Promise<void> {
  const { patch, queryClient, t } = deps;
  const key = queryKeys.documentsLayout();
  // A read still in flight (the first GET) would land after the flip and
  // paint the old layout until the PUT answered. Cancel it first; only then
  // is the flip safe, because a cancelled fetch reverts the cache as it
  // settles. Without one in flight the flip stays synchronous.
  if (queryClient.isFetching({ queryKey: key }) > 0) {
    await queryClient.cancelQueries({ queryKey: key });
  }
  const previous = queryClient.getQueryData<DocumentsLayout>(key);
  queryClient.setQueryData<DocumentsLayout>(key, {
    ...(previous ?? DEFAULT_DOCUMENTS_LAYOUT),
    ...patch,
  });
  try {
    const saved = await apiPut<DocumentsLayout>(
      "/api/documents/inbound/layout",
      { version: 1, ...patch },
    );
    if (saved) queryClient.setQueryData(key, saved);
  } catch {
    queryClient.setQueryData(key, previous);
    toast.error(t("documents.layout.saveFailed"));
  }
}

/** The vault presentation, persisted per user. Defaults until the read lands. */
export function useDocumentsLayout(enabled: boolean = true): {
  layout: DocumentsLayout;
  isLayoutLoading: boolean;
  setView: (view: DocumentsLayoutView) => Promise<void>;
  setArrangement: (arrangement: DocumentsLayoutArrangement) => Promise<void>;
} {
  const queryClient = useQueryClient();
  const { t } = useTranslations();

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.documentsLayout(),
    queryFn: () => apiGet<DocumentsLayout>("/api/documents/inbound/layout"),
    staleTime: 5 * 60 * 1000,
    enabled,
  });

  return {
    layout: data ?? DEFAULT_DOCUMENTS_LAYOUT,
    isLayoutLoading: enabled && isLoading,
    setView: (view) =>
      runSetDocumentsLayout({ patch: { view }, queryClient, t }),
    setArrangement: (arrangement) =>
      runSetDocumentsLayout({ patch: { arrangement }, queryClient, t }),
  };
}
