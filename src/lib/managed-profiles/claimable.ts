/**
 * The profile state a handover link depends on, read the same way by every
 * step of a handover: minting, the status panel, the preview and the claim.
 */

export const CLAIMABLE_PROFILE_SELECT = {
  managedProfileAt: true,
  deletionRequestedAt: true,
};

/**
 * Whether a profile can be handed over at all: still managed and not pending
 * deletion. A claim of one pending deletion would hand its new owner an
 * account locked at once and erased when the window ends; its deletion
 * revokes the open link, and the claim asks again under the lock.
 */
export function isClaimableProfile<
  P extends { managedProfileAt: Date | null; deletionRequestedAt: Date | null },
>(profile: P | null): profile is P & { managedProfileAt: Date } {
  return Boolean(profile?.managedProfileAt) && !profile?.deletionRequestedAt;
}
