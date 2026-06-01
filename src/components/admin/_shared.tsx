"use client";

import { useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Cpu, Fingerprint, Globe, KeyRound } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { PasswordInput as SharedPasswordInput } from "@/components/ui/password-input";

/**
 * Re-export the canonical password input so admin sections have access to
 * the same accessible (aria-labelled) toggle the settings sections use.
 * The earlier in-file copy lacked an aria-label which surfaced as a
 * `button-name` violation on `/admin/integrations` and
 * `/admin/users` (axe-core, WCAG 2.1.2).
 */
export const PasswordInput = SharedPasswordInput;

export interface AdminUser {
  id: string;
  username: string;
  email: string | null;
  role: string;
  createdAt: string;
  passkeyCount: number;
}

export interface WorkerStatus {
  running: boolean;
  startedAt: string | null;
  lastHeartbeat: string | null;
  lastReminderCheck: string | null;
  lastWithingsSync: string | null;
  lastInsightsRun: string | null;
  jobsProcessed: number;
  errors: number;
}

export interface SystemStatus {
  version: string;
  nodeVersion: string;
  gitCommit: string;
  buildTime: string;
  startTime: string;
  database: string;
  worker: WorkerStatus;
  counts: {
    users: number;
    measurements: number;
    medications: number;
    intakeEvents: number;
    activeTokens: number;
    activeSessions: number;
  };
  integrations: {
    umami: { configured: boolean; enabled: boolean } | null;
    glitchtip: { configured: boolean; enabled: boolean } | null;
    webPush: { configured: boolean } | null;
    bugReport: { configured: boolean } | null;
  };
}

export interface AdminSettings {
  registrationEnabled: boolean;
  defaultLocale: string;
  telegramGlobal: boolean;
  ntfyGlobal: boolean;
  webPushGlobal: boolean;
  webPushVapidPublicKey: string | null;
  webPushVapidSubject: string | null;
  webPushVapidConfigured: boolean;
  apiGlobal: boolean;
  umamiEnabled: boolean;
  umamiScriptUrl: string | null;
  umamiWebsiteId: string | null;
  glitchtipEnabled: boolean;
  glitchtipDsn: string | null;
  glitchtipEnvironment: string | null;
  bugReportRepo: string | null;
  bugReportConfigured: boolean;
  bugReportEnabled: boolean;
  reminderLateMinutes: number;
  reminderMissedMinutes: number;
  // v1.4.25 W7 — null means "fall back to Europe/Berlin in the resolver".
  defaultUserTimezone: string | null;
  moodLogGlobal?: boolean;
}

export interface AdminAuditEntry {
  id: string;
  action: string;
  ipAddress: string | null;
  location: string | null;
  // v1.4.27 B3 — populated from the bundled GeoLite2-ASN MMDB at
  // audit-creation time. Both nullable: older rows, private/loopback
  // IPs, and offline-miss rows stay valid.
  asn: number | null;
  carrier: string | null;
  details: string | null;
  createdAt: string;
  user: { id: string; username: string } | null;
}

export interface ApiTokenInfo {
  id: string;
  name: string;
  permissions: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  revoked: boolean;
  user: { id: string; username: string };
}

export type FeedbackStatusType =
  | "OPEN"
  | "ACKNOWLEDGED"
  | "RESOLVED"
  | "ARCHIVED";
export type FeedbackCategoryType =
  | "BUG"
  | "FEATURE_REQUEST"
  | "QUESTION"
  | "OTHER";

export interface FeedbackItem {
  id: string;
  userId: string | null;
  email: string | null;
  category: FeedbackCategoryType;
  subject: string;
  description: string;
  status: FeedbackStatusType;
  adminNote: string | null;
  gitHubIssueUrl: string | null;
  metadata: Record<string, unknown> | null;
  screenshotBase64: string | null;
  createdAt: string;
  updatedAt: string;
  user: { username: string } | null;
}

export interface FeedbackListResponse {
  items: FeedbackItem[];
  meta: {
    total: number;
    limit: number;
    offset: number;
    countsByStatus: Partial<Record<FeedbackStatusType, number>>;
  };
}

export const FEEDBACK_STATUS_TABS: FeedbackStatusType[] = [
  "OPEN",
  "ACKNOWLEDGED",
  "RESOLVED",
  "ARCHIVED",
];

export function StatusItem({
  icon: Icon,
  label,
  value,
  className,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div className="bg-muted/50 rounded-lg p-3">
      <div className="text-muted-foreground flex items-center gap-1.5 text-xs">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <p className={`mt-1 text-sm font-semibold ${className ?? ""}`}>{value}</p>
    </div>
  );
}

export function SettingsToggle({
  label,
  description,
  icon: Icon,
  checked,
  onCheckedChange,
  disabled,
}: {
  label: string;
  description?: string;
  icon?: React.ComponentType<{ className?: string }>;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled: boolean;
}) {
  // v1.4.27 MB7 / CF-56 — stack the toggle row vertically on `<sm` so
  // the label + description don't have to compete with the switch for
  // horizontal space on Pixel 5 (the German "Registration enabled — …"
  // description used to wrap to 4 lines while the switch ate ~52 px on
  // the right). At `sm:` the original side-by-side layout returns.
  // The switch self-aligns to the right via `self-end` on the stacked
  // branch so it stays a familiar tap target.
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="flex min-w-0 items-center gap-2">
        {Icon && <Icon className="text-muted-foreground h-4 w-4 shrink-0" />}
        <div className="min-w-0">
          <p className="text-sm font-medium">{label}</p>
          {description && (
            <p className="text-muted-foreground text-xs">{description}</p>
          )}
        </div>
      </div>
      <Switch
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        className="self-end sm:self-auto"
      />
    </div>
  );
}

export function useAdminSettings() {
  return useQuery({
    queryKey: queryKeys.adminSettings(),
    queryFn: async () => {
      const res = await fetch("/api/admin/settings");
      if (!res.ok) throw new Error("Failed");
      return (await res.json()).data as AdminSettings;
    },
  });
}

export function useUpdateSettings() {
  const queryClient = useQueryClient();
  const { t } = useTranslations();
  return useMutation({
    mutationFn: async (data: Record<string, unknown>) => {
      const res = await fetch("/api/admin/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        throw new Error(await getApiErrorMessage(res));
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.adminSettings() });
      toast.success(t("common.saved"));
    },
    onError: (err) => {
      toast.error(
        err instanceof Error && err.message
          ? err.message
          : t("admin.settingsSaveError"),
      );
    },
  });
}

export async function getApiErrorMessage(response: Response): Promise<string> {
  const fallback = `HTTP ${response.status}`;
  try {
    const json = (await response.json()) as { error?: string };
    if (typeof json?.error === "string" && json.error.trim().length > 0) {
      return json.error;
    }
  } catch {
    return fallback;
  }
  return fallback;
}

/**
 * Shared `auth.*` audit-action label map. Two surfaces consume it
 * today (`/admin/login-overview` and the dashboard recent-activity
 * preview), and any future audit feed will need the same translation
 * lookup. New auth actions are added here once instead of being
 * copy-pasted into every consumer.
 */
export function useAuthActionLabels(): Record<string, string> {
  const { t, locale } = useTranslations();
  return useMemo(
    () => ({
      "auth.register": t("admin.authRegister"),
      "auth.login": t("admin.authLogin"),
      "auth.login.passkey": t("admin.authLoginPasskey"),
      "auth.login.password": t("admin.authLoginPassword"),
      "auth.login.failed": t("admin.authLoginFailed"),
      "auth.logout": t("admin.authLogout"),
      "auth.passkey.register": t("admin.authPasskeyRegister"),
      "auth.passkey.delete": t("admin.authPasskeyDelete"),
      "auth.token.autoissue.native": t("admin.authTokenAutoissueNative"),
      "auth.token.refresh": t("admin.authTokenRefresh"),
      "auth.token.revoke": t("admin.authTokenRevoke"),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [locale],
  );
}

/**
 * v1.4.25 W8b — Provider column for the Login-Übersicht.
 *
 * The audit log doesn't have a dedicated `provider` field; the action
 * name itself encodes how the login happened (`auth.login.passkey`,
 * `auth.bearer.success`, …). We derive a coarse provider tag from
 * the action so admins can see at a glance whether each row is a
 * password, passkey, API token, or OAuth (Withings) event.
 *
 * Keep the mapping exhaustive — every `auth.*` action that lands in
 * the audit table must resolve to one of `password | passkey |
 * api_token | withings | unknown`. New actions are wired here once,
 * mirroring the convention established by `useAuthActionLabels`.
 */
export type AuthProvider =
  | "password"
  | "passkey"
  | "api_token"
  | "withings"
  | "unknown";

export function providerForAction(action: string): AuthProvider {
  if (
    action === "auth.login.passkey" ||
    action === "auth.passkey.register" ||
    action === "auth.passkey.delete"
  ) {
    return "passkey";
  }
  if (
    action === "auth.login.password" ||
    action === "auth.password.change" ||
    // Failed sign-ins go through the password endpoint — the passkey
    // flow has its own `auth.login.failed` row but `details.reason`
    // disambiguates further; for the column tag, "password" is the
    // truthful summary of how the credential was offered.
    action === "auth.login.failed"
  ) {
    return "password";
  }
  if (
    action === "auth.bearer.success" ||
    action === "auth.bearer.failure" ||
    action === "auth.token.autoissue.native" ||
    action === "auth.token.refresh" ||
    action === "auth.token.refresh.failed" ||
    action === "auth.token.refresh.revoke" ||
    action === "auth.token.revoke"
  ) {
    return "api_token";
  }
  if (action.startsWith("auth.withings")) {
    return "withings";
  }
  return "unknown";
}

const AUTH_PROVIDER_ICONS = {
  password: KeyRound,
  passkey: Fingerprint,
  api_token: Cpu,
  withings: Globe,
  unknown: Globe,
} as const;

export function iconForAuthProvider(
  provider: AuthProvider,
): React.ComponentType<{ className?: string }> {
  return AUTH_PROVIDER_ICONS[provider];
}

/**
 * i18n label map for the Provider column. Keys match `AuthProvider`
 * so callers can index directly: `labels[providerForAction(action)]`.
 */
export function useAuthProviderLabels(): Record<AuthProvider, string> {
  const { t, locale } = useTranslations();
  return useMemo(
    () => ({
      password: t("admin.providerPassword"),
      passkey: t("admin.providerPasskey"),
      api_token: t("admin.providerApiToken"),
      withings: t("admin.providerWithings"),
      unknown: t("admin.providerUnknown"),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [locale],
  );
}

/**
 * v1.4.27 B3 — Fold a GeoLite2 `autonomous_system_organization`
 * string down to a short DACH carrier label. The MMDB returns the
 * verbose legal-entity name ("Deutsche Telekom AG", "1&1 Telecom
 * GmbH", "Telefónica Germany GmbH & Co. OHG"); the admin overview
 * needs a glanceable chip ("Telekom", "Vodafone", "1&1", "O2").
 *
 * The match is case-insensitive substring against the canonical
 * carrier name; unknown organisations fall through to the original
 * string so the chip still carries provenance.
 */
export function carrierShortLabel(rawAsnOrg: string): string {
  const haystack = rawAsnOrg.toLowerCase();
  if (haystack.includes("telekom")) return "Telekom";
  if (haystack.includes("vodafone")) return "Vodafone";
  if (haystack.includes("1&1")) return "1&1";
  // Telefónica / O2 / Telefonica Germany / O2 Deutschland → "O2"
  if (haystack.includes("telefonica") || haystack.includes("telefónica")) {
    return "O2";
  }
  if (haystack.includes("o2 ") || haystack.endsWith(" o2")) return "O2";
  return rawAsnOrg;
}

/**
 * v1.4.25 W8b — Build the CSV record set for the audit-log export.
 *
 * Pulled out of the section component so the column order, header
 * mapping, and provider/outcome derivation are reachable from a
 * pure unit test without rendering the React tree. Marc's spec pins
 * the column order at `timestamp → user → IP → location → provider
 * → outcome` (email is absent from the audit-log API and would
 * require schema/API changes that are out of scope). `action` and
 * `details` follow so the export keeps the full triage payload.
 *
 * v1.4.27 B3: the `carrier` column lands between `location` and
 * `provider` so the geo-derived fields stay grouped.
 *
 * `formatTimestamp` is injected (not imported) so the production
 * callsite passes the user-tz formatter (`formatInUserTz`) while the
 * unit test passes a deterministic stub.
 */
export interface AuditCsvEntry {
  createdAt: string;
  action: string;
  ipAddress: string | null;
  location: string | null;
  // v1.4.27 B3 — both optional so legacy fixture data that predates
  // the column landing still compiles against this shape.
  carrier?: string | null;
  asn?: number | null;
  details: string | null;
  user: { id: string; username: string } | null;
}

export interface AuditCsvLabels {
  timestamp: string;
  user: string;
  ip: string;
  location: string;
  carrier: string;
  provider: string;
  outcome: string;
  action: string;
  details: string;
  outcomeFailed: string;
  outcomeSuccess: string;
  unknownUser: string;
  providerLabels: Record<AuthProvider, string>;
}

export interface AuditCsvRecord {
  timestamp: string;
  user: string;
  ip: string;
  location: string;
  carrier: string;
  provider: string;
  outcome: string;
  action: string;
  details: string;
  // Index signature so the record satisfies the structural
  // `ExportableRecord` contract used by `toCSV`. Fixed columns above
  // still drive the order of the emitted CSV.
  [key: string]: string;
}

export function buildAuditLogCsvRecords(
  entries: AuditCsvEntry[],
  labels: AuditCsvLabels,
  formatTimestamp: (iso: string) => string,
): AuditCsvRecord[] {
  return entries.map((entry) => {
    const provider = providerForAction(entry.action);
    const isFailed =
      entry.action === "auth.login.failed" ||
      entry.action === "auth.bearer.failure" ||
      entry.action === "auth.token.refresh.failed";
    return {
      timestamp: formatTimestamp(entry.createdAt),
      user: entry.user?.username ?? labels.unknownUser,
      ip: entry.ipAddress ?? "",
      location: entry.location ?? "",
      carrier: entry.carrier ? carrierShortLabel(entry.carrier) : "",
      provider: labels.providerLabels[provider],
      outcome: isFailed ? labels.outcomeFailed : labels.outcomeSuccess,
      action: entry.action,
      details: entry.details ?? "",
    };
  });
}

export function auditLogCsvHeaderLabels(
  labels: AuditCsvLabels,
): Record<keyof AuditCsvRecord, string> {
  return {
    timestamp: labels.timestamp,
    user: labels.user,
    ip: labels.ip,
    location: labels.location,
    carrier: labels.carrier,
    provider: labels.provider,
    outcome: labels.outcome,
    action: labels.action,
    details: labels.details,
  };
}

export function useSystemStatus() {
  return useQuery({
    queryKey: queryKeys.adminStatus(),
    queryFn: async () => {
      const res = await fetch("/api/admin/status");
      if (!res.ok) throw new Error("Failed");
      return (await res.json()).data as SystemStatus;
    },
  });
}

/** Helpful-rate tint shared by the AI-quality + Coach-feedback tables.
 * Green ≥80 %, yellow ≥50 %, orange below. */
export function helpfulRateColour(rate: number): string {
  if (rate >= 0.8) return "text-dracula-green";
  if (rate >= 0.5) return "text-dracula-yellow";
  return "text-dracula-orange";
}

export interface PublicVersion {
  version: string;
  buildSha: string | null;
  builtAt: string | null;
  offlineGeoEnabled?: boolean;
}

/** Shared `/api/version` reader — the system-status section + overview
 * summary both surface app version / build SHA / offline-geo state. */
export function usePublicVersion() {
  return useQuery({
    queryKey: queryKeys.publicVersion(),
    queryFn: async () => {
      const res = await fetch("/api/version");
      if (!res.ok) throw new Error("Failed to load version");
      return (await res.json()).data as PublicVersion;
    },
    staleTime: 5 * 60_000,
  });
}
