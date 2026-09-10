"use client";

/**
 * v1.37.0 — the reads and writes behind the managed-profile surface.
 *
 * A managed profile is a record with no login of its own. It is created by the
 * person who will look after it, and from that moment it exists only through
 * its Guardians — which is why every call here refreshes the ACCOUNT payload
 * and not merely the panel it was fired from.
 *
 * That is the one property worth stating up front. The list of profiles a
 * Guardian looks after is not a read of its own: it is `accountAccess.accounts`
 * on `GET /api/auth/me`, filtered to the managed entries, because the Guardian's
 * relationship to the profile IS a MANAGE grant. So a creation that refreshed
 * the sharing panel and not the payload would leave the new profile invisible —
 * in the switcher, in the banner, and in this card — until the next boot. Every
 * mutation below therefore goes through `invalidateGrantReads`, the one entry
 * `use-account-grants.ts` already publishes for exactly this fan-out; the
 * managed-profile family rides it as a key prefix rather than as a second
 * invalidation path (`grantDependentKeys`).
 */

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";

import { apiDelete, apiGet, apiPatch, apiPost } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";
import { invalidateGrantReads } from "@/lib/queries/use-account-grants";
import type { GrantParty } from "@/lib/queries/use-account-grants";
import type { Locale } from "@/lib/i18n/config";

/**
 * Exactly the body `POST /api/managed-profiles` accepts.
 *
 * The route's schema is `.strict()`, so an extra key is a 422 with nothing
 * useful in it — a form that helpfully posted an empty `heightCm` would be
 * refused for a field the person never saw. Naming the four fields as a type
 * rather than passing the form state through is what stops that: a fifth field
 * added to the form cannot reach the wire without somebody deciding it should.
 */
export interface CreateManagedProfileInput {
  displayName: string;
  /** ISO `yyyy-MM-dd`, or null. Never synthesised from a year. */
  dateOfBirth: string | null;
  locale: Locale;
  /** IANA zone name. */
  timezone: string;
  /** `User.gender`. Null is a real answer — "not recorded" — not an omission. */
  gender: ManagedProfileGender;
}

/** The three values `User.gender` takes, plus the honest absence. */
export type ManagedProfileGender = "MALE" | "FEMALE" | "OTHER" | null;

/** What the create, read and update routes all answer with. */
export interface ManagedProfileView {
  id: string;
  displayName: string | null;
  dateOfBirth: string | null;
  gender: ManagedProfileGender;
  /** Nullable, as the column is. A record created here always carries one. */
  locale: string | null;
  timezone: string;
  recordKind: "managed";
}

/**
 * The body `PATCH /api/managed-profiles/{id}` accepts, plus the record it is
 * addressed to.
 *
 * Every field optional, at least one required, and `.strict()` on the server —
 * so the mutation names the fields one by one rather than spreading form state,
 * exactly as the creation does. An absent key means "leave it"; an explicit
 * null on the two nullable fields clears it. `profileId` addresses the request
 * and is deliberately not in the body: the schema would refuse it.
 */
export interface UpdateManagedProfileInput {
  profileId: string;
  displayName?: string;
  dateOfBirth?: string | null;
  locale?: Locale;
  timezone?: string;
  gender?: ManagedProfileGender;
}

/**
 * Everything a managed-profile lifecycle change makes stale.
 *
 * Exported as a plain function over a `QueryClient` for the same reason
 * `invalidateGrantReads` is: a test can hand it a real client, seed the reads
 * and check they came back invalidated. "The mutation calls invalidate" is a
 * claim about the source; "the account payload comes back invalidated" is the
 * claim that decides whether the new profile appears in the switcher.
 */
export function invalidateManagedProfileReads(queryClient: QueryClient): void {
  invalidateGrantReads(queryClient);
}

/** The same refresh, bound to the mounted client. */
function useInvalidateManagedProfiles() {
  const queryClient = useQueryClient();
  return () => invalidateManagedProfileReads(queryClient);
}

/**
 * Create a record somebody looks after.
 *
 * `requireFreshMfa` guards the route, so a 401 carrying
 * `meta.errorCode: auth.stepup.required` is the EXPECTED first answer for
 * anybody who has a second factor and has not proved it recently. The form
 * routes that into the app's re-verification path rather than into a generic
 * failure — see `managed-profile-create-form.tsx`.
 */
export function useCreateManagedProfile() {
  const invalidate = useInvalidateManagedProfiles();
  return useMutation({
    mutationKey: queryKeys.managedProfileCreate(),
    mutationFn: (input: CreateManagedProfileInput) =>
      apiPost<ManagedProfileView>("/api/managed-profiles", input),
    onSuccess: invalidate,
  });
}

/**
 * The record as it stands, for the form that is about to change it.
 *
 * The account payload names a managed record and nothing more, so a form
 * opened from the Guardian's own panel cannot show the timezone, the language,
 * the date of birth or the sex it is about to overwrite. This is that read.
 * `enabled` is what keeps it off the wire until somebody opens the form: a
 * Guardian with four records should not fetch four identities to paint a list
 * that shows none of them.
 */
export function useManagedProfile(profileId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.managedProfile(profileId),
    queryFn: () =>
      apiGet<ManagedProfileView>(`/api/managed-profiles/${profileId}`),
    enabled,
  });
}

/**
 * Change a record somebody looks after.
 *
 * Guarded by `requireFreshMfa` like every other act in this family, so a 401
 * carrying `meta.errorCode: auth.stepup.required` is the expected first answer
 * rather than a failure — the form routes it into the re-verification path.
 *
 * The whole family is invalidated on success because the display name is what
 * the switcher, the record banner and this card all identify the record by, and
 * the record's own identity read is dropped alongside so a second edit opens
 * from the server's version rather than from the one that was just replaced.
 */
export function useUpdateManagedProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: queryKeys.managedProfileUpdate(),
    mutationFn: (input: UpdateManagedProfileInput) =>
      apiPatch<ManagedProfileView>(
        `/api/managed-profiles/${input.profileId}`,
        managedProfileEditBody(input),
      ),
    onSuccess: (_result, input) => {
      invalidateManagedProfileReads(queryClient);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.managedProfile(input.profileId),
      });
    },
  });
}

/**
 * The wire body, composed once and exported.
 *
 * Pure and separate from the mutation for the same reason `guardianInviteBody`
 * is: the integration suite posts the REAL body through the REAL route rather
 * than a hand-written copy, which is the assembly a two-sided test misses.
 *
 * Each key is present only when the caller named it, because the route reads
 * absence as "leave it" and an explicit `undefined` would serialise to nothing
 * anyway — stating it is what stops a later spread from sending five keys for a
 * one-field edit.
 */
export function managedProfileEditBody(
  input: UpdateManagedProfileInput,
): Record<string, unknown> {
  return {
    ...(input.displayName !== undefined
      ? { displayName: input.displayName }
      : {}),
    ...(input.dateOfBirth !== undefined
      ? { dateOfBirth: input.dateOfBirth }
      : {}),
    ...(input.locale !== undefined ? { locale: input.locale } : {}),
    ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
    ...(input.gender !== undefined ? { gender: input.gender } : {}),
  };
}

/** One person who looks after a profile, as the roster publishes them. */
export interface ManagedProfileGuardian {
  /** The grant row — what `DELETE .../guardians/{grantId}` takes. */
  grantId: string;
  account: GrantParty;
  /**
   * PENDING or ACTIVE. Only ACTIVE counts toward the last-Guardian floor, and
   * the server counts the same way — a pending invitation does not let the
   * last Guardian leave.
   */
  state: "PENDING" | "ACTIVE";
  invitedAt: string;
  acceptedAt: string | null;
}

/**
 * Who else looks after this profile.
 *
 * The read the removal control needs to exist at all: a Guardian grant has the
 * PROFILE as grantor, so it never appears in the caller's own given-list and
 * `GET /api/account/grants` cannot supply the `grantId`. It is also where the
 * last-Guardian floor is counted from BEFORE the act rather than discovered as
 * a 409 after it.
 */
export function useManagedProfileGuardians(profileId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.managedProfileGuardians(profileId),
    queryFn: () =>
      apiGet<ManagedProfileGuardian[]>(
        `/api/managed-profiles/${profileId}/guardians`,
      ),
    enabled,
  });
}

/**
 * Delete a managed profile, and everything recorded in it.
 *
 * The variable is the profile id, which is what lets a refusal be rendered on
 * the row it was refused for rather than somewhere near it.
 *
 * This route emits no last-Guardian refusal, and that is deliberate rather
 * than an omission: deleting the profile is the documented way OUT of the
 * floor. A Guardian may not strand a record with nobody looking after it, but
 * they may end the record.
 */
export function useDeleteManagedProfile() {
  const invalidate = useInvalidateManagedProfiles();
  return useMutation({
    mutationKey: queryKeys.managedProfileDelete(),
    mutationFn: (profileId: string) =>
      apiDelete<{ deleted: true }>(`/api/managed-profiles/${profileId}`),
    onSuccess: invalidate,
  });
}

/**
 * Exactly the body `POST /api/managed-profiles/{id}/guardians` accepts, plus
 * the profile the request is addressed to.
 *
 * The route's schema is `.strict()` and names two fields. `identifier` is the
 * invitee's username OR e-mail, matched case-insensitively — the same
 * identifier the ordinary grant invitation takes. `expiresAt` is an ISO
 * datetime WITH an offset: a bare `YYYY-MM-DD` is a 422, which is why the
 * caller runs it through the shared end-of-day helper rather than sending the
 * date field's raw value.
 */
export interface InviteManagedProfileGuardianInput {
  profileId: string;
  identifier: string;
  expiresAt: string | null;
}

/**
 * Offer somebody else a share in looking after this profile.
 *
 * The grant is created PENDING and reaches the invitee's ordinary "invitations
 * to you" card, where they accept it exactly as they would any other. Nothing
 * here accepts on their behalf, and until they accept they do not count toward
 * the last-Guardian floor.
 */
export function useInviteManagedProfileGuardian() {
  const invalidate = useInvalidateManagedProfiles();
  return useMutation({
    mutationKey: queryKeys.managedProfileGuardianInvite(),
    mutationFn: (input: InviteManagedProfileGuardianInput) =>
      apiPost(
        `/api/managed-profiles/${input.profileId}/guardians`,
        guardianInviteBody(input),
      ),
    onSuccess: invalidate,
  });
}

/**
 * The wire body, composed once and exported.
 *
 * Pure and separate from the mutation so the integration suite can post the
 * REAL body through the REAL route rather than a hand-written copy of it. A
 * hand-written copy is the shape of test that stays green while the client
 * renames a field: both ends prove themselves and the assembly between them is
 * what dropped it.
 *
 * `profileId` addresses the request and is deliberately not in the body: the
 * route's schema is `.strict()` and would refuse it.
 */
export function guardianInviteBody(input: InviteManagedProfileGuardianInput): {
  identifier: string;
  expiresAt: string | null;
} {
  return { identifier: input.identifier, expiresAt: input.expiresAt };
}

/**
 * End another Guardian's access.
 *
 * Another Guardian's, never one's own: the service refuses a target grant whose
 * grantee is the caller and the route turns that into the same 404 an unknown
 * profile gets. A Guardian steps away through the renounce control on the
 * shared-access panel instead.
 *
 * `variables` carries both ids so a refusal can be rendered on the guardian row
 * it belongs to rather than on the panel.
 */
export function useRemoveManagedProfileGuardian() {
  const invalidate = useInvalidateManagedProfiles();
  return useMutation({
    mutationKey: queryKeys.managedProfileGuardianRemove(),
    mutationFn: ({
      profileId,
      grantId,
    }: {
      profileId: string;
      grantId: string;
    }) => apiDelete(`/api/managed-profiles/${profileId}/guardians/${grantId}`),
    onSuccess: invalidate,
  });
}
