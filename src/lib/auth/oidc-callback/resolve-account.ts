/**
 * Which account an SSO sign-in belongs to (`GET /api/auth/oidc/callback`),
 * once the provider has authenticated a subject.
 *
 *   1. The durable identity match: the (issuer, sub) pair stamped on a
 *      previous login, link or provision.
 *   2. An account that already holds the verified email: never linked on the
 *      email alone. Pinned to another identity it is a conflict; otherwise
 *      the link waits for the account's own credential.
 *   3. Nobody: provision, while registration is open.
 *
 * A refusal names the reason the callback redirects with.
 */
import { prisma } from "@/lib/db";
import type { User } from "@/generated/prisma/client";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { deriveUniqueUsername } from "@/lib/auth/oidc";
import { resolveServerDefaultTimezone } from "@/lib/tz/resolver";

export type OidcAccountResolution =
  | { kind: "user"; user: User }
  | { kind: "refused"; reason: string }
  | { kind: "linkPending"; userId: string };

/** A refusal; the reason is the `?error=` the callback redirects with. */
function refuse(reason: string): OidcAccountResolution {
  return { kind: "refused", reason };
}

interface OidcSubject {
  issuer: string;
  sub: string;
  email: string | null;
  emailVerified: boolean | undefined;
  ip: string;
}

/**
 * Refresh the display email only, and only from a claim the IdP explicitly
 * marks verified. Skipped when another account already holds the address
 * (`email` is unique); the login itself proceeds either way, keyed by
 * (issuer, sub). Email is deliberately NOT consulted for the match: after
 * the stamp it is a display field, so an IdP-side email change can refresh
 * it but can never re-point the login at a different account.
 */
async function refreshDisplayEmail(
  user: User,
  subject: OidcSubject,
): Promise<User> {
  const displayEmail = subject.email ? subject.email.toLowerCase() : null;
  if (
    !displayEmail ||
    subject.emailVerified !== true ||
    user.email?.toLowerCase() === displayEmail
  ) {
    return user;
  }
  const emailTaken = await prisma.user.findFirst({
    where: {
      email: { equals: displayEmail, mode: "insensitive" },
      NOT: { id: user.id },
    },
    select: { id: true },
  });
  if (emailTaken) return user;
  return prisma.user.update({
    where: { id: user.id },
    data: { email: displayEmail },
  });
}

async function registrationOpen(): Promise<boolean> {
  const userCount = await prisma.user.count();
  try {
    const settings = await prisma.appSettings.findUnique({
      where: { id: "singleton" },
    });
    if (settings && !settings.registrationEnabled && userCount > 0) {
      return false;
    }
  } catch {
    // Table may not exist yet; allow provisioning (matches register/route.ts).
  }
  return true;
}

/**
 * The first provisioned user becomes ADMIN. Deriving that role from an early
 * count and then creating without coordination is the check-then-act race
 * the password-register route closed: two concurrent first logins racing the
 * empty-DB window would both observe `0` and both be minted ADMIN. The
 * count+insert is serialised behind a transaction-scoped advisory lock
 * (released on commit/rollback) and re-counted *inside* the lock, so the
 * second provision observes the first's committed row and is minted USER.
 * The lock key STRING matches the register route's: an OIDC first login
 * racing a password first registration is serialised against the same lock,
 * so only one ADMIN can ever be minted.
 */
async function provision(
  subject: OidcSubject & { email: string },
): Promise<User> {
  const username = await deriveUniqueUsername(subject.email, (candidate) =>
    prisma.user
      .findUnique({ where: { username: candidate } })
      .then((u: unknown) => u !== null),
  );
  // Same server-default resolution the register route uses: an
  // SSO-provisioned account has no registration form to carry the
  // browser-detected timezone.
  const timezone = await resolveServerDefaultTimezone();
  const user = await prisma.$transaction(async (tx) => {
    // `pg_advisory_xact_lock` returns void, which the client cannot
    // deserialize as a column; selecting FROM it yields a plain int row.
    await tx.$queryRaw`
      SELECT 1 AS locked
      FROM pg_advisory_xact_lock(hashtextextended('register:first-admin', 0))
    `;
    const priorUsers = await tx.user.count();
    const role = priorUsers === 0 ? "ADMIN" : "USER";
    return tx.user.create({
      data: {
        email: subject.email.toLowerCase(),
        username,
        passwordHash: null,
        role,
        timezone,
        oidcIssuer: subject.issuer,
        oidcSub: subject.sub,
      },
    });
  });
  await auditLog("auth.oidc.provisioned", {
    userId: user.id,
    ipAddress: subject.ip,
  });
  return user;
}

export async function resolveOidcAccount(
  subject: OidcSubject,
): Promise<OidcAccountResolution> {
  // (1) Durable identity match.
  const stamped = await prisma.user.findFirst({
    where: { oidcIssuer: subject.issuer, oidcSub: subject.sub },
  });
  if (stamped) {
    return { kind: "user", user: await refreshDisplayEmail(stamped, subject) };
  }

  // No stamped identity yet: both remaining paths (link-once, provision)
  // bind this (issuer, sub) to an account keyed by email, so the claim must
  // be explicitly `email_verified: true`. An ABSENT claim is a reject, not a
  // benefit of the doubt: an IdP that does not assert verification cannot
  // anchor a link that later gates a health record.
  const email = subject.email;
  if (!email) {
    annotate({ meta: { reason: "no_email" } });
    return refuse("oidc_no_email");
  }
  if (subject.emailVerified !== true) {
    annotate({ meta: { reason: "email_unverified" } });
    return refuse("oidc_email_unverified");
  }

  const byEmail = await prisma.user.findFirst({
    where: { email: { equals: email, mode: "insensitive" } },
  });
  if (byEmail) {
    // (2) Link ONCE. An account already pinned to a different IdP identity
    // is never silently re-bound: a rebind would let a second IdP identity
    // that acquires the same email capture the account. Audited so the
    // operator can see the collision.
    if (byEmail.oidcIssuer !== null || byEmail.oidcSub !== null) {
      await auditLog("auth.oidc.link_conflict", {
        userId: byEmail.id,
        ipAddress: subject.ip,
      });
      annotate({ meta: { reason: "identity_conflict" } });
      return refuse("oidc_identity_conflict");
    }
    // (2b) Never link on the email alone. The local address was never
    // verified (anyone can register with it or type it into a profile), so
    // matching it proves nothing about who owns the account. Record the link
    // this login would make; the callback sends the browser to sign in to
    // the account with its own credential, and the link is made there
    // (`completePendingOidcLink`), and only for this account.
    await auditLog("auth.oidc.link_pending", {
      userId: byEmail.id,
      ipAddress: subject.ip,
    });
    annotate({ meta: { reason: "link_confirmation_required" } });
    return { kind: "linkPending", userId: byEmail.id };
  }

  // (3) Provision.
  if (!(await registrationOpen())) {
    annotate({ meta: { reason: "registration_disabled" } });
    return refuse("oidc_registration_disabled");
  }
  return { kind: "user", user: await provision({ ...subject, email }) };
}
