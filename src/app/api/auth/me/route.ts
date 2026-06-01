import { apiSuccess } from "@/lib/api-response";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { setOnboardingPendingCookie } from "@/lib/auth/session";
import { buildAvatarUrl } from "@/lib/avatar";
import { decrypt } from "@/lib/crypto";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();

  // v1.4.22 W5 reconcile (Sr-H1) — fall-back resync for legacy
  // sessions that predate the cookie. New sessions anchor the cookie
  // inside `createSession` itself, so this is no longer the primary
  // write path; it just makes sure pre-v1.4.22 sessions get their
  // cookie set on the first /me roundtrip after the upgrade.
  await setOnboardingPendingCookie(user.onboardingCompletedAt == null);

  annotate({ action: { name: "auth.me" } });

  // v1.7.0 — patient-identity fields for the health-record export. The
  // KVNR is stored encrypted; decrypt fail-soft so a key-rotation gap on
  // one row never 500s the whole profile fetch (the field just reads
  // null and the user re-enters it).
  let insuranceNumber: string | null = null;
  if (user.insuranceNumberEncrypted) {
    try {
      insuranceNumber = decrypt(user.insuranceNumberEncrypted);
    } catch {
      insuranceNumber = null;
    }
  }

  return apiSuccess({
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role ?? "USER",
    heightCm: user.heightCm,
    dateOfBirth: user.dateOfBirth,
    gender: user.gender,
    timezone: user.timezone,
    onboardingCompletedAt: user.onboardingCompletedAt,
    onboardingTourCompleted: user.onboardingTourCompleted,
    // v1.5.5 — self-hosted avatar. Replaces the Gravatar leak; the
    // URL is relative so PWA + native clients render identically
    // and the `?v={updatedAtMs}` suffix busts the browser cache on
    // a re-upload. Null when the user has not uploaded an avatar
    // yet; clients paint the username-initials fallback.
    avatarUrl: user.avatarUpdatedAt
      ? buildAvatarUrl(user.id, user.avatarUpdatedAt)
      : null,
    glucoseUnit: user.glucoseUnit ?? null,
    // v1.7.0 — global metric/imperial display preference. Canonical
    // storage stays SI; this only drives the display-time transform
    // branch. Null defaults to "metric" on the client.
    unitPreference: user.unitPreference === "imperial" ? "imperial" : "metric",
    lastReportPracticeName: user.lastReportPracticeName ?? null,
    // v1.4.47 W3 — per-user Coach opt-out. Default `false` if the
    // column is absent (partial-deploy rollback safety, see migration
    // 0078 commentary). Every Coach mount point on the client checks
    // `user.disableCoach` BELOW the operator-level `flags.coach`
    // short-circuit; both gates must agree to paint the affordance.
    disableCoach: user.disableCoach ?? false,
    // v1.7.0 — health-record export identity fields. All optional.
    fullName: user.fullName ?? null,
    insurerName: user.insurerName ?? null,
    insuranceNumber,
  });
});
