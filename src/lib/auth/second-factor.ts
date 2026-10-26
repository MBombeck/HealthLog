import { prisma } from "@/lib/db";

/**
 * Does this account have a SECOND FACTOR at all?
 *
 * Either factor enrols it: a confirmed TOTP secret OR a registered WebAuthn
 * security key. A webauthn-only account must clear step-up too, so every
 * boundary that asks this question tracks `requireFreshMfa`'s either-factor
 * rule rather than reading `totpConfirmedAt` alone. It was written out three
 * times before it was a function, which is two more places for the second arm
 * to be forgotten.
 *
 * DELIBERATELY DOES NOT COUNT A PRIMARY PASSKEY, even though a passkey login
 * stamps `mfaVerifiedAt` and could therefore satisfy the gate. This predicate
 * answers "is there a second factor", and that is the question
 * `requireFreshMfaIfEnrolled` asks before deciding whether account deletion, the
 * data reset, the password change, the encrypted export and key rotation demand
 * a step-up at all. Counting a passkey here would silently pull every
 * passkey-holding account into a gate those routes have never applied to them —
 * a behaviour change to five destructive actions, made in passing, for the
 * benefit of a sixth. `canProveFreshFactor` in `auth/guards/fresh-factor.ts` is where the wider question
 * lives.
 *
 * Since v1.43.3 a passkey DOES count as a second factor where the gate is
 * unconditional: `requireFreshMfa` defaults to `any-possession`, so a
 * passkey-only account clears the managed-profile acts with a passkey
 * re-proof instead of being told to enrol something. That decision was made
 * there and not here, on purpose; the note beside `FreshFactorProofSource`
 * lists what it does and does not change.
 */
export async function hasSecondFactorEnrolled(user: {
  id: string;
  totpConfirmedAt: Date | null;
}): Promise<boolean> {
  if (user.totpConfirmedAt) return true;
  const webauthnKeyCount = await prisma.webauthnMfaCredential.count({
    where: { userId: user.id },
  });
  return webauthnKeyCount > 0;
}

/**
 * A proof the recent-proof gate can ask for. `password` and `passkey` on an
 * account without a second factor; `totp`, `webauthn` and `passkey` on one
 * with a second factor, where a password alone has never been enough.
 */
export type RecentProofMethod = "password" | "totp" | "webauthn" | "passkey";

/**
 * The proofs that would satisfy `assertRecentCookieProof` for this
 * account. Also what `POST /api/auth/reproof` accepts, so the dialog and the
 * endpoint cannot disagree.
 */
export async function recentProofMethods(
  user: { id: string; totpConfirmedAt: Date | null },
  enrolled?: boolean,
): Promise<RecentProofMethod[]> {
  const hasSecond = enrolled ?? (await hasSecondFactorEnrolled(user));
  // Whether a password exists is read here rather than off the caller's row:
  // the hash is not part of the per-request user (`SESSION_USER_SELECT`).
  const [keys, passkeys, credential] = await Promise.all([
    prisma.webauthnMfaCredential.count({ where: { userId: user.id } }),
    prisma.passkey.count({ where: { userId: user.id } }),
    prisma.user.findUnique({
      where: { id: user.id },
      select: { passwordHash: true },
    }),
  ]);
  const methods: RecentProofMethod[] = [];
  if (hasSecond) {
    if (user.totpConfirmedAt) methods.push("totp");
    if (keys > 0) methods.push("webauthn");
  } else if (credential?.passwordHash) {
    methods.push("password");
  }
  if (passkeys > 0) methods.push("passkey");
  return methods;
}
