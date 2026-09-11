import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import {
  consumeInviteToken,
  recordInviteConsumer,
} from "@/lib/auth/invite-token";
import { registerSchema } from "@/lib/validations/auth";
import { hashPassword, checkPasswordStrength } from "@/lib/auth/password";
import { createSession, getSession } from "@/lib/auth/session";
import { recordSignInDevice } from "@/lib/auth/login-alert";
import { auditLog } from "@/lib/auth/audit";
import {
  apiSuccess,
  apiError,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { checkAuthSurfaceRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { ensureDbCompatibility } from "@/lib/db-compat";
import { NextRequest, NextResponse } from "next/server";
import { apiHandler } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { resolveServerLocale } from "@/lib/i18n/server-locale";
import { checkPasswordBreach } from "@/lib/auth/hibp";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import {
  isValidTimezone,
  resolveServerDefaultTimezone,
} from "@/lib/tz/resolver";
import { isOidcOnly } from "@/lib/auth/oidc";

export const POST = apiHandler(async (request: NextRequest) => {
  // OIDC_ONLY must block self-registration too — otherwise anyone can
  // self-provision a fresh password account and bypass the operator's
  // SSO-only policy outright, invite token or not.
  if (isOidcOnly()) {
    return apiError("Registration is disabled. Sign in with SSO.", 403, {
      errorCode: "oidc_only",
    });
  }

  // v1.38.19 — an invitation creates a NEW account, so it can never be
  // accepted from inside a live session.
  //
  // The route used to read no session at all: a request carrying a valid
  // `healthlog_session` was handled exactly like an anonymous one, and the
  // unconditional `createSession` at the end overwrote the caller's cookie
  // with the fresh account's. An admin opening his own invite link to check it
  // was signed out of his admin account and into a stranger's onboarding, his
  // previous session row still valid server-side and no longer reachable.
  //
  // Refused BEFORE the rate limit on purpose: this is a state, not an attempt,
  // and spending the 5-per-15-minutes bucket on it would lock the door for the
  // person the invitation is actually for, who may well share the IP.
  // `getSession` is the optional resolver — it answers `null` for an anonymous
  // caller instead of throwing, which `requireAuth` would.
  const existingSession = await getSession();
  if (existingSession) {
    annotate({ action: { name: "auth.register.refused_authenticated" } });
    return apiError(
      "Already signed in — sign out first to use an invitation",
      409,
      { errorCode: "auth.already_authenticated" },
    );
  }

  // v1.4.43 W13 M-4 — tighten to a global bucket when the trust chain
  // is misconfigured; otherwise byte-equivalent per-IP semantics.
  const rl = await checkAuthSurfaceRateLimit(
    request,
    "auth:register",
    5,
    15 * 60 * 1000,
  );
  const ip = rl.ip ?? "unknown";
  if (!rl.allowed) {
    return NextResponse.json(
      {
        data: null,
        error: "Too many registration attempts. Please try again later.",
      },
      { status: 429, headers: rateLimitHeaders(rl) },
    );
  }

  await ensureDbCompatibility();

  const userCount = await prisma.user.count();

  // Check if registration is enabled.
  // Safety valve: when there are zero users, always allow bootstrap registration.
  let registrationEnabled = true;
  try {
    const settings = await prisma.appSettings.findUnique({
      where: { id: "singleton" },
    });
    if (settings && !settings.registrationEnabled && userCount > 0) {
      registrationEnabled = false;
    }
  } catch {
    // Table may not exist yet; allow registration
  }
  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: 64 * 1024,
  });

  if (jsonError) return jsonError;
  const parsed = registerSchema.safeParse(body);

  if (!parsed.success) {
    // v1.4.43 W6 — multi-issue 422.
    return returnAllZodIssues(parsed.error, 422);
  }

  const {
    email,
    username,
    password,
    timezone: timezoneInput,
    inviteToken,
  } = parsed.data;

  // v1.15.20 — closed registration still admits a valid invite. The
  // token itself is 32 random bytes behind a keyed hash and the surface
  // is rate-limited (5 / 15 min / IP), so a distinct "invalid invite"
  // message is a UX win, not an oracle.
  if (!registrationEnabled && !inviteToken) {
    return apiError("Registration is disabled", 403);
  }

  // v1.4.25 W7 — accept a browser-detected timezone from the
  // registration form. Validate against the runtime IANA list; on
  // any invalid value (or absence), fall back to the admin-
  // configured server default. The `User.timezone` column has a
  // hard-coded "Europe/Berlin" default at the schema layer, so the
  // worst-case chain still produces a usable string.
  let timezone: string;
  const trimmedTimezone = timezoneInput?.trim() ?? "";
  if (trimmedTimezone && isValidTimezone(trimmedTimezone)) {
    timezone = trimmedTimezone;
  } else {
    timezone = await resolveServerDefaultTimezone();
  }

  // Check if email or username already taken (unified message to prevent enumeration)
  const [existingEmail, existingUsername] = await Promise.all([
    prisma.user.findUnique({ where: { email } }),
    prisma.user.findUnique({ where: { username } }),
  ]);
  if (existingEmail || existingUsername) {
    return apiError("Username or email already taken", 409);
  }

  // Validate password strength (locale-aware feedback)
  const locale = await resolveServerLocale({ request });
  const strength = checkPasswordStrength(password, [username, email], locale);
  if (!strength.isAcceptable) {
    return apiError(
      strength.feedback[0] || "Password too weak (score < 3)",
      422,
    );
  }

  // v1.23 — reject a registration password found in a known breach corpus
  // (HIBP k-anonymity). Fail-open on an unreachable HIBP.
  const breach = await checkPasswordBreach(password);
  if (breach?.breached) {
    return apiError(
      getServerTranslator(locale).t("auth.passwordBreached"),
      422,
    );
  }

  const passwordHash = await hashPassword(password);

  // v1.15.20 — consume the invite LAST, after every other validation,
  // so a taken username or weak password can never burn one of the
  // invite's uses. The guarded increment inside `consumeInviteToken`
  // makes the last-use race safe under concurrent signups.
  //
  // v1.16.1 — consume whenever a token was sent, not only when the
  // invite is the admission requirement. A signup through an invite
  // link while registration happens to be open used to leave the
  // invite untouched, so the issuer's ledger (uses, consumers) was
  // silently incomplete. The consume stays a hard 403 only when
  // registration is closed (the invite is the door key); under open
  // registration a stale or exhausted token is annotated and the
  // signup proceeds uninvited.
  let inviteId: string | null = null;
  if (inviteToken) {
    const consumed = await consumeInviteToken(inviteToken);
    if (consumed.ok) {
      inviteId = consumed.inviteId;
    } else {
      annotate({
        action: { name: "auth.register.invite_rejected" },
        meta: {
          reason: consumed.reason,
          registration_open: registrationEnabled,
        },
      });
      if (!registrationEnabled) {
        return apiError("Invalid or expired invite", 403);
      }
    }
  }

  // v1.28.42 (M1) — the first registered user becomes ADMIN. Deriving that
  // role from the early `userCount` (read at the top, before all the
  // validation above) and then creating without coordination is a
  // check-then-act race: on a freshly-exposed instance two registrations
  // racing the empty-DB window both observe `0` and are BOTH minted ADMIN.
  // Serialise the count+insert behind a transaction-scoped advisory lock
  // (released on commit/rollback) and re-count *inside* the lock, so the
  // second registration always observes the first's committed row and is
  // minted USER. The lock scope is only the count + insert — none of the
  // argon2 hash / HIBP / invite work above runs under it. Mirrors the
  // advisory-lock single-flight in `drain-per-sample-cumulative.ts`.
  //
  // v1.28.42 (L4) — a concurrent same-email/username signup (both passed the
  // findUnique probe above before either committed) surfaces the unique
  // violation as `P2002`; map it to the unified 409 rather than an unhandled
  // 500. The DB unique index is the real guard against duplicate accounts;
  // this only fixes the status code under the race.
  const user = await prisma
    .$transaction(async (tx) => {
      // `pg_advisory_xact_lock` returns void, which the client cannot
      // deserialize as a column — selecting FROM it yields a plain int row.
      await tx.$queryRaw`
        SELECT 1 AS locked
        FROM pg_advisory_xact_lock(hashtextextended('register:first-admin', 0))
      `;
      const priorUsers = await tx.user.count();
      const role = priorUsers === 0 ? "ADMIN" : "USER";
      return tx.user.create({
        data: {
          email,
          username,
          passwordHash,
          role,
          timezone,
        },
      });
    })
    .catch((err: unknown) => {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        return null;
      }
      throw err;
    });

  if (user === null) {
    return apiError("Username or email already taken", 409);
  }

  // Create session immediately. v1.4.22 W5 reconcile (Sr-H1) —
  // `createSession` anchors the `hl_onboarding` cookie itself; fresh
  // users are always pending so the proxy redirects on first
  // navigation instead of waiting for hydration.
  const ua = request.headers.get("user-agent");
  await createSession(user.id, true, ip, ua);

  // v1.23 — record the registering device silently so the account's first
  // login from this same device does not immediately fire a "new device"
  // alert. A genuinely new device later still alerts on its first sighting.
  void recordSignInDevice({
    userId: user.id,
    ip,
    userAgent: ua,
    alertOnNew: false,
  });

  // Stamp the consumer onto the invite (informational, best-effort —
  // the use itself was already counted atomically above).
  if (inviteId) {
    await recordInviteConsumer(inviteId, user.id);
  }

  await auditLog("auth.register", {
    userId: user.id,
    ipAddress: ip,
    details: { method: "password", timezone, invited: inviteId !== null },
  });

  annotate({ action: { name: "auth.register" } });

  return apiSuccess(
    {
      user: { id: user.id, username: user.username, email: user.email },
    },
    201,
  );
});
