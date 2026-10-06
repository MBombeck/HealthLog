"use client";

/**
 * v1.27.x — read + mutate the user's Coach goal / if-then plans.
 *
 * One shared hook for the chat thread's proposal confirm cards and the
 * `/coach/plans` management page. Reads unwrap `(await res.json()).data` per
 * the envelope convention; every key routes through `queryKeys.coachPlans()`
 * so a lifecycle mutation invalidates both list slots at once. Mirrors
 * `use-coach-reminders.ts`, the sibling episodic-memory hook.
 *
 * The extractor is the only writer of plan TEXT — this surface only confirms
 * (proposed → active), marks met / abandoned, or soft-deletes. There is no
 * prose editor by design: the PATCH contract never accepts the encrypted
 * free-text fields.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { queryKeys } from "@/lib/query-keys";
import { apiDelete, apiGet, apiPatch } from "@/lib/api/api-fetch";

export interface CoachPlanDTO {
  id: string;
  metric: string;
  /** Null only when the row's encryption key id rotated out of the map. */
  ifCue: string | null;
  thenAction: string | null;
  target: string | null;
  status: string;
  reviewDate: string | null;
  sourceConversationId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface PlanFilter {
  /** Single lifecycle status (`proposed`, `active`, …). */
  status?: string;
  /** Named group: `open` | `past` | `all`. Mutually exclusive with status. */
  scope?: string;
}

function filterKey(filter?: PlanFilter): string | undefined {
  if (filter?.status) return `status:${filter.status}`;
  if (filter?.scope) return `scope:${filter.scope}`;
  return undefined;
}

async function fetchPlans(filter?: PlanFilter): Promise<CoachPlanDTO[]> {
  const qs = filter?.status
    ? `?status=${encodeURIComponent(filter.status)}`
    : filter?.scope
      ? `?scope=${encodeURIComponent(filter.scope)}`
      : "";
  const data = await apiGet<{ plans?: CoachPlanDTO[] } | undefined>(
    `/api/coach/plans${qs}`,
  );
  return data?.plans ?? [];
}

/** List the caller's plans, optionally filtered by status or scope. */
export function useCoachPlans(opts?: {
  filter?: PlanFilter;
  enabled?: boolean;
}) {
  const filter = opts?.filter;
  return useQuery({
    queryKey: queryKeys.coachPlans(filterKey(filter)),
    queryFn: () => fetchPlans(filter),
    enabled: opts?.enabled ?? true,
  });
}

/** Lifecycle + delete mutations, invalidating every plans list slot. */
export function useCoachPlanMutations() {
  const queryClient = useQueryClient();
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.coachPlansAll() });

  const setStatus = useMutation({
    mutationFn: async (args: { id: string; status: string }) => {
      await apiPatch(`/api/coach/plans/${encodeURIComponent(args.id)}`, {
        status: args.status,
      });
      return args.id;
    },
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      await apiDelete(`/api/coach/plans/${encodeURIComponent(id)}`);
      return id;
    },
    onSuccess: invalidate,
  });

  return { setStatus, remove };
}
