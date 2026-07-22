import type { QueryClient, QueryKey } from "@tanstack/react-query";

import { apiFetchRaw } from "@/lib/api/api-fetch";

interface EnabledSettings {
  enabled: boolean;
}

export async function persistChannelEnabled(
  endpoint: string,
  enabled: boolean,
  fallbackError: string,
): Promise<void> {
  const response = await apiFetchRaw(endpoint, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });

  if (!response.ok) {
    const json = (await response.json()) as { error?: string };
    throw new Error(json.error || fallbackError);
  }
}

export function optimisticallySetChannelEnabled<T extends EnabledSettings>(
  queryClient: QueryClient,
  queryKey: QueryKey,
  enabled: boolean,
): T | undefined {
  const previous = queryClient.getQueryData<T>(queryKey);
  queryClient.setQueryData<T>(queryKey, (current) =>
    current ? { ...current, enabled } : current,
  );
  return previous;
}

export function rollbackChannelEnabled<T extends EnabledSettings>(
  queryClient: QueryClient,
  queryKey: QueryKey,
  previous: T | undefined,
): void {
  queryClient.setQueryData(queryKey, previous);
}
