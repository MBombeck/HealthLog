/**
 * Query keys — auth session, passkeys, and per-user account preferences.
 * Part of the centralized factory; aggregated in `./index.ts`.
 */
export const authKeys = {
  auth: () => ["auth"] as const,
  /**
   * v1.4.40 — the `useAuth` hook's `["auth", "me"]` shape was a
   * recurring source of factory drift (audit H1 — "`useAuth` uses
   * `["auth", "me"]` but `queryKeys.auth()` returns `["auth"]`"). Both
   * shapes share the `["auth"]` prefix so existing prefix-invalidations
   * still match, but the centralised name makes the call site
   * obviously factory-routed.
   */
  authMe: () => ["auth", "me"] as const,
  authRegistrationStatus: () => ["auth", "registration-status"] as const,
  authOidcStatus: () => ["auth", "oidc", "status"] as const,
  /**
   * v1.4.40 — Settings → AI surfaces and the targets editor
   * subscribe to the user-thresholds API. Centralise the key so a
   * future rename (e.g. `["user","limits"]`) doesn't drift across the
   * three call sites (settings/thresholds-editor-section,
   * settings/ai-section, targets/target-edit-sheet).
   */
  userThresholds: () => ["user", "thresholds"] as const,

  passkeys: () => ["passkeys"] as const,

  /**
   * v1.23 — the user-facing active-session list behind
   * `GET /api/auth/me/sessions`. Revoking a single session or signing out
   * everywhere invalidates this key so the surface re-reads the live set.
   */
  sessions: () => ["auth", "sessions"] as const,

  /**
   * v1.23 — the shared security-activity feed behind
   * `GET /api/auth/me/security-activity` (logins, MFA, password change,
   * session revoke, exports, deletions). Consumed by the account-security
   * surface and the privacy dashboard.
   */
  securityActivity: () => ["auth", "security-activity"] as const,

  /**
   * v1.23 — the security settings hub reads second-factor status (TOTP
   * enabled, recovery codes remaining, registered security keys, passkey-nudge
   * dismissal) from `GET /api/auth/me/mfa`. Mutations that change a factor
   * invalidate this key so the hub reflects the new state immediately.
   */
  mfaStatus: () => ["auth", "mfa", "status"] as const,

  /**
   * v1.23 — the "remember this device" trusted-device list behind
   * `GET /api/auth/me/trusted-devices`. Revoking a device (or all of them)
   * invalidates this key so the surface re-reads the live set.
   */
  trustedDevices: () => ["auth", "trusted-devices"] as const,

  userAiProvider: () => ["user", "ai-provider"] as const,
  userProfile: () => ["user", "profile"] as const,
  /**
   * v1.7.0 — the roaming notification prefs blob behind
   * `GET/PATCH /api/auth/me/notification-prefs` (medication delivery
   * default + mood reminder hour). Distinct from
   * `notificationsPreferences()` (the per-event push toggles on the
   * `/notifications` page) so the two never collide in the cache.
   */
  authNotificationPrefs: () => ["auth", "me", "notification-prefs"] as const,

  /**
   * v1.4.25 — per-user, per-metric-class source priority. The
   * Settings → Sources surface reads + writes this key; saving
   * invalidates `analytics()` because the cumulative-metric aggregator
   * folds the new priority into the SLEEP_DURATION daily total
   * immediately.
   */
  sourcePriority: () => ["auth", "source-priority"] as const,
};
