"use client";

/**
 * v1.36.0 — the reads and writes behind the shared-access panel.
 *
 * One module for the whole surface, because every mutation here invalidates
 * the same three things and the standing rule about cache invalidation is
 * easiest to keep when there is one place that can break it. `grantDependentKeys`
 * (`@/lib/query-keys`) is that place: the grant list, the owner's activity
 * feed, and the account payload — the last because `accountAccess` is what
 * paints the switcher and the banner, and a revoke that refreshed the panel but
 * not the payload leaves a switcher entry pointing at a record the server has
 * just closed.
 *
 * Nothing in here decides anything. `state` arrives resolved from the same
 * function the request resolver's own predicate is built on, so the panel
 * cannot render "active" on a row the server has stopped honouring.
 */

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";

import { apiDelete, apiGet, apiPost } from "@/lib/api/api-fetch";
import { grantDependentKeys, queryKeys } from "@/lib/query-keys";
import type { ShareDomain } from "@/lib/sharing/scope";

/** The other party to a grant, as far as anyone is told about them. */
export interface GrantParty {
  id: string;
  username: string;
  displayName: string | null;
}

export type GrantState = "PENDING" | "ACTIVE" | "EXPIRED" | "REVOKED";

/** The three levels an invitation can carry, spelled as the wire spells them. */
export type GrantAccess = "READ" | "WRITE" | "MANAGE";

export interface GrantRow {
  id: string;
  account: GrantParty;
  access: GrantAccess;
  /**
   * The sections the grant opens, or null for the entire record. Resolved by
   * the server in the consent screen's reading order; an empty array means the
   * grant opens nothing, which is the fail-closed reading of a stored scope
   * the server could not parse.
   */
  scope: ShareDomain[] | null;
  state: GrantState;
  invitedAt: string;
  acceptedAt: string | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  revokedBy: "GRANTOR" | "GRANTEE" | null;
}

export interface GrantList {
  /** Grants this account has offered on its own record. */
  given: GrantRow[];
  /** Grants offered to this account on somebody else's. */
  received: GrantRow[];
}

export interface RecordActivityEntry {
  id: string;
  actor: GrantParty | null;
  action: string;
  accesses: number | null;
  createdAt: string;
}

export interface RecordActivity {
  entries: RecordActivityEntry[];
  /**
   * How far back the feed can see, in days — resolved by the server from the
   * same setting the purge job reads. The view states it rather than implying
   * the list is everything that ever happened.
   */
  retentionDays: number;
}

export function useAccountGrants(enabled = true) {
  return useQuery({
    queryKey: queryKeys.accountGrants(),
    queryFn: () => apiGet<GrantList>("/api/account/grants"),
    enabled,
  });
}

export function useRecordActivity(enabled = true) {
  return useQuery({
    queryKey: queryKeys.accountActivity(),
    queryFn: () => apiGet<RecordActivity>("/api/account/activity"),
    enabled,
  });
}

/**
 * Refresh everything a grant transition can have changed.
 *
 * A plain function over a QueryClient rather than a hook body, so a test can
 * hand it a real client, seed the three reads and check they came back
 * invalidated — which is the only way to tell an invalidation that runs from
 * one that was written and never wired.
 */
export function invalidateGrantReads(queryClient: QueryClient): void {
  for (const key of grantDependentKeys) {
    void queryClient.invalidateQueries({ queryKey: key });
  }
}

/**
 * The same refresh, bound to the mounted client.
 *
 * Shared by all four mutations rather than written out per hook: the day one
 * of them forgets the account payload is the day a revoked record keeps its
 * switcher entry.
 */
function useInvalidateGrants() {
  const queryClient = useQueryClient();
  return () => invalidateGrantReads(queryClient);
}

export interface InviteInput {
  identifier: string;
  /** ISO-8601 with offset, or null for a grant that runs until somebody ends it. */
  expiresAt: string | null;
  /**
   * What the invitation offers. Required rather than optional even though the
   * server defaults an omitted field to READ: a caller that does not name the
   * level has not decided it, and this is the one moment the level can be
   * decided at all.
   */
  access: GrantAccess;
  /**
   * Which sections it opens, or null for the entire record.
   *
   * Required for the same reason as `access` and stated as `null` rather than
   * omitted, so that "the whole record" is something a caller says out loud.
   * The server refuses an empty array, an unknown key, and any scope at all
   * beside MANAGE.
   */
  scope: ShareDomain[] | null;
}

export function useInviteGrant() {
  const invalidate = useInvalidateGrants();
  return useMutation({
    mutationKey: queryKeys.accountGrantInvite(),
    mutationFn: (input: InviteInput) =>
      apiPost<GrantRow>("/api/account/grants", input),
    onSuccess: invalidate,
  });
}

export function useAcceptGrant() {
  const invalidate = useInvalidateGrants();
  return useMutation({
    mutationKey: queryKeys.accountGrantAccept(),
    mutationFn: (grantId: string) =>
      apiPost<GrantRow>(`/api/account/grants/${grantId}/accept`),
    onSuccess: invalidate,
  });
}

export function useRevokeGrant() {
  const invalidate = useInvalidateGrants();
  return useMutation({
    mutationKey: queryKeys.accountGrantRevoke(),
    mutationFn: (grantId: string) =>
      apiDelete<GrantRow & { sessionsCleared: number }>(
        `/api/account/grants/${grantId}`,
      ),
    onSuccess: invalidate,
  });
}

export function useRenounceGrant() {
  const invalidate = useInvalidateGrants();
  return useMutation({
    mutationKey: queryKeys.accountGrantRenounce(),
    mutationFn: (grantId: string) =>
      apiPost<GrantRow & { sessionsCleared: number }>(
        `/api/account/grants/${grantId}/renounce`,
      ),
    onSuccess: invalidate,
  });
}
