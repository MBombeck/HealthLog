/**
 * Query keys — account sharing (v1.36.0).
 * Part of the centralized factory; aggregated in `./index.ts`.
 *
 * Note what these keys deliberately do NOT carry: the acting account. That
 * dimension lives on the QueryClient's `queryKeyHashFn`
 * (`./record-scope.ts`), which folds it into every entry in the app at once
 * — including these. Adding it here as well would partition the same cache
 * twice under two rules, which is the two-deciders shape in miniature.
 *
 * The reads below are all non-delegable by construction: `/api/account/grants`
 * and the record-activity feed both resolve through a bare `requireAuth()` and
 * refuse while a switch is on. They are still record-scoped like everything
 * else, so a session that switches out and back never reads a grant list
 * cached under the wrong scope.
 */
export const sharingKeys = {
  /**
   * Grants in both directions (`GET /api/account/grants`). One key for one
   * endpoint: the route answers "who can see my record, and whose can I see"
   * in a single payload precisely so no client renders half of it.
   */
  accountGrants: () => ["account", "grants"] as const,

  /**
   * The owner's record-activity feed (`GET /api/account/activity`) — who
   * opened their record, and when.
   */
  accountActivity: () => ["account", "activity"] as const,

  /**
   * v1.37.0 — the managed-profile family, as one prefix.
   *
   * Present so a grant transition can invalidate the whole family at once:
   * accepting a Guardian invitation is an ordinary `POST
   * /api/account/grants/{id}/accept`, and it moves a row on a roster that
   * endpoint knows nothing about. Listing this prefix in `grantDependentKeys`
   * is what keeps the two in step without the accept path having to know a
   * managed profile exists.
   */
  managedProfiles: () => ["managed-profiles"] as const,

  /**
   * Who looks after one managed profile (`GET
   * /api/managed-profiles/{id}/guardians`). Keyed by profile because a
   * Guardian may look after more than one, and a single key for all of them
   * would be the same-key-different-shape collision the factory exists to
   * prevent.
   */
  managedProfileGuardians: (profileId: string) =>
    ["managed-profiles", profileId, "guardians"] as const,

  /**
   * One managed record's identity (`GET /api/managed-profiles/{id}`). Keyed by
   * profile for the same reason the roster is, and under the same prefix so a
   * grant transition invalidates it with the rest of the family.
   */
  managedProfile: (profileId: string) =>
    ["managed-profiles", profileId, "profile"] as const,

  /** Mutation keys — kept in the factory so no bare array reaches a call site. */
  accountGrantInvite: () => ["account", "grants", "invite"] as const,
  accountGrantAccept: () => ["account", "grants", "accept"] as const,
  accountGrantRevoke: () => ["account", "grants", "revoke"] as const,
  accountGrantRenounce: () => ["account", "grants", "renounce"] as const,
  accountSwitchMutation: () => ["account", "switch"] as const,
  managedProfileCreate: () => ["managed-profiles", "create"] as const,
  managedProfileUpdate: () => ["managed-profiles", "update"] as const,
  managedProfileDelete: () => ["managed-profiles", "delete"] as const,
  managedProfileGuardianInvite: () =>
    ["managed-profiles", "guardian", "invite"] as const,
  managedProfileGuardianRemove: () =>
    ["managed-profiles", "guardian", "remove"] as const,
};
