/**
 * The confinement half of the second-factor policy: a browser session of an
 * account past its enrolment date reaches only the enrolment surface. A
 * sign-in token of the app is not confined in 1.50 (see `caller.ts`); a new
 * native sign-in is refused at the door (`mfa-native-refusal.ts`).
 *
 * The hint cookie (`hl_mfa_enroll`) sends pages to `/enroll-mfa` without a
 * database read, but a browser that drops the cookie, or a script holding the
 * session cookie, never sees that redirect. This is the server half, and it
 * asks the policy on every request (`resolveMfaEnrollment`: no query for an
 * account with TOTP, the request's one settings read for an account no policy
 * covers). It never trusts a due date stored on the session: a session that
 * began before the policy existed carries none, and a policy switched on, or
 * a grace period shortened, after sign-in would not show in one. Still
 * required: the request is refused unless it is one the enrolment needs.
 *
 * Which request it is comes from the wide event's path for an API route
 * (`apiHandler` sets it from the request URL) and, for a page render, from the
 * `x-healthlog-path` header the proxy writes on every page request. A request
 * with neither is treated as outside the allowlist: confinement fails closed.
 */
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { prisma } from "@/lib/db";
import { HttpError } from "@/lib/api-errors";
import { getEvent } from "@/lib/logging/context";
import {
  MFA_POLICY_USER_SELECT,
  resolveMfaEnrollment,
  sessionMfaDueAt,
  sessionMfaRecordStale,
  type MfaEnrollment,
  type MfaPolicyUser,
} from "@/lib/auth/mfa-enrollment";
import { noticeMfaGrace } from "@/lib/auth/mfa-grace-notice";

/** Request header the proxy stamps with the page path. */
export const PAGE_PATH_HEADER = "x-healthlog-path";

/**
 * One route a confined caller may still reach. `match: "prefix"` admits every
 * path under `path`; `methods` null admits every method.
 */
export interface MfaOpenPath {
  path: string;
  match: "exact" | "prefix";
  methods: readonly string[] | null;
}

function exact(path: string): MfaOpenPath {
  return { path, match: "exact", methods: null };
}

/**
 * The API routes a confined caller may reach: reading the account, signing
 * out (including removing this device's push binding), enrolling, and the
 * public probes. Published on `/api/auth/me` as `mfaEnrollment.openPaths`, so
 * a client reads the list instead of keeping a copy of it.
 */
export const MFA_ENROLLMENT_OPEN_PATHS: readonly MfaOpenPath[] = [
  exact("/api/auth/me"),
  exact("/api/auth/logout"),
  exact("/api/auth/reproof"),
  exact("/api/auth/oidc/reproof"),
  exact("/api/auth/passkeys"),
  exact("/api/auth/passkey/register-options"),
  exact("/api/auth/passkey/register-verify"),
  exact("/api/auth/me/mfa"),
  { path: "/api/auth/me/mfa/", match: "prefix", methods: null },
  { path: "/api/devices/", match: "prefix", methods: ["DELETE"] },
  exact("/api/health"),
  exact("/api/version"),
];

/** Pages that render the enrolment cards. */
const PAGE_PREFIXES = ["/enroll-mfa", "/settings/security"];

function startsWithSegment(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

export function isMfaEnrollmentApiPath(path: string, method?: string): boolean {
  const verb = (method ?? "").toUpperCase();
  return MFA_ENROLLMENT_OPEN_PATHS.some(
    (open) =>
      (open.match === "exact"
        ? path === open.path
        : path.startsWith(open.path) && path.length > open.path.length) &&
      (open.methods === null || open.methods.includes(verb)),
  );
}

export function isMfaEnrollmentPagePath(path: string): boolean {
  return PAGE_PREFIXES.some((p) => startsWithSegment(path, p));
}

/**
 * The due date a new session of this account carries, read at sign-in: null
 * when no policy covers the account or it has a factor.
 */
export async function mfaDueAtForSignIn(userId: string): Promise<Date | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: MFA_POLICY_USER_SELECT,
  });
  if (!user) return null;
  return sessionMfaDueAt(await resolveMfaEnrollment(userId, user));
}

/**
 * The second-factor state of this caller: the one answer the browser gate
 * below enforces and `/api/auth/me` reports. A narrow token
 * (`isScopedCredential`) is not a sign-in and is never confined, so it reads
 * `none`; a demo reads `none` through `resolveMfaEnrollment`. An account that
 * has entered its grace period is sent its one notice from here
 * (`noticeMfaGrace`), which covers the web and the app alike.
 */
export async function callerMfaEnrollment(
  user: MfaPolicyUser & { id: string },
  credential: "sign-in" | "narrow-token",
): Promise<MfaEnrollment> {
  if (credential === "narrow-token") return { state: "none", dueAt: null };
  const enrollment = await resolveMfaEnrollment(user.id, user);
  noticeMfaGrace(user.id, enrollment);
  return enrollment;
}

/**
 * `mfaEnrollment` on `/api/auth/me`: the caller's state from
 * `callerMfaEnrollment` and the routes a confined browser session may still
 * reach. For a browser session `required` means exactly that every route
 * outside `openPaths` is refused. A sign-in token is not confined in 1.50:
 * for it `required` means the date has passed, a new sign-in of the account
 * is refused until a factor exists, and from 1.51 the token is held to
 * `openPaths` too.
 */
export async function mfaEnrollmentPayload(
  user: MfaPolicyUser & { id: string },
  credential: "sign-in" | "narrow-token",
): Promise<MfaEnrollment & { openPaths: readonly MfaOpenPath[] }> {
  return {
    ...(await callerMfaEnrollment(user, credential)),
    openPaths: MFA_ENROLLMENT_OPEN_PATHS,
  };
}

function requestPathAndMethod(): { path?: string; method?: string } {
  const event = getEvent();
  return { path: event?.getHttpPath(), method: event?.getHttpMethod?.() };
}

interface ConfinableSession {
  id: string;
  mfaEnrollmentDueAt: Date | null;
  user: MfaPolicyUser & { id: string };
}

function enrollmentRequiredError(): HttpError {
  return new HttpError(
    403,
    "Set up two-factor sign-in to continue",
    "auth.mfa.enrollment_required",
  );
}

/**
 * Refuse a browser request when the session's account has to enrol a factor
 * now and the request is not one the enrolment needs. The session's recorded
 * due date is brought in line with the answer (a record, not an input).
 */
export async function enforceMfaEnrollment(
  session: ConfinableSession,
): Promise<void> {
  const enrollment = await callerMfaEnrollment(session.user, "sign-in");
  if (sessionMfaRecordStale(session.mfaEnrollmentDueAt, enrollment)) {
    const dueAt = sessionMfaDueAt(enrollment);
    // The record only: a failed write must not decide the request.
    await prisma.session
      .update({
        where: { id: session.id },
        data: { mfaEnrollmentDueAt: dueAt },
      })
      .catch(() => {});
    session.mfaEnrollmentDueAt = dueAt;
  }
  if (enrollment.state !== "required") return;

  const { path: apiPath, method } = requestPathAndMethod();
  if (apiPath !== undefined) {
    if (isMfaEnrollmentApiPath(apiPath, method)) return;
    throw enrollmentRequiredError();
  }

  let pagePath: string | null = null;
  try {
    pagePath = (await headers()).get(PAGE_PATH_HEADER);
  } catch {
    pagePath = null;
  }
  if (pagePath !== null && isMfaEnrollmentPagePath(pagePath)) return;
  redirect("/enroll-mfa");
}
