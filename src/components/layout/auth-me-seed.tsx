"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { adoptMePayload } from "@/hooks/use-auth";
import type { AccountSeed } from "@/lib/auth/account-seed";
import { queryKeys } from "@/lib/query-keys";

/**
 * Puts the account the root layout resolved on the server into the query
 * cache before the shell reads it.
 *
 * Without it every protected page shipped a spinner in its HTML: the shell
 * waits for `/api/auth/me` before it mounts a page, and the browser could ask
 * only after the scripts had loaded. Seeded, the shell renders the page on the
 * server and on the first client render alike.
 *
 * The seed is stamped as already stale, so the shell's own query still
 * fetches `/api/auth/me` once in the background: that response is the one
 * that resyncs the onboarding and second-factor hint cookies, it brings the
 * fields the seed withholds (`src/lib/auth/account-seed.ts`), and any change
 * since the render replaces the seed the usual way. The refetch is the point,
 * so the seed is not given a staleTime of its own.
 *
 * Rendered as the shell's preceding sibling, so its state initializer runs
 * before the shell's first `useAuth` in the same pass. In the browser it also
 * applies the payload (`adoptMePayload`): the record-session context every
 * later request asserts is adopted before any page below can send one. On the
 * server it only seeds the per-render cache.
 */
export function AuthMeSeed({ payload }: { payload: AccountSeed | null }) {
  const queryClient = useQueryClient();
  useState(() => {
    if (payload === null) return null;
    if (queryClient.getQueryData(queryKeys.authMe()) !== undefined) return null;
    const user = adoptMePayload(payload, {
      apply: typeof window !== "undefined",
    });
    queryClient.setQueryData(queryKeys.authMe(), user, { updatedAt: 0 });
    return null;
  });
  return null;
}
