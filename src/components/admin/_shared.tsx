"use client";

import { useMemo } from "react";
import { StatTile } from "@/components/admin/_stat-tile";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Cpu, Fingerprint, Globe, KeyRound } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { PasswordInput as SharedPasswordInput } from "@/components/ui/password-input";
import { apiGet, apiPut } from "@/lib/api/api-fetch";

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
  // v1.23 — per-user "require a second factor" override.
  mfaEnforced: boolean;
  // Document vault — per-user storage-quota override in bytes; null means
  // the instance-wide default applies.
  documentQuotaBytes: number | null;
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
}

/** One queue with exhausted-retry failures, as `/api/admin/status` reports it. */
export interface FailingQueue {
  queue: string;
  failures: number;
  lastFailedAt: string;
  lastError: string;
}

export interface SystemStatus {
  version: string;
  nodeVersion: string;
  gitCommit: string;
  buildTime: string;
  startTime: string;
  database: string;
  worker: WorkerStatus;
  /**
   * Queues whose jobs exhausted their retries recently. `null` means the
   * deployment has no pg-boss schema to ask (web-only); an empty `queues`
   * array means it was asked and nothing is failing. The two are rendered
   * differently on purpose — absence is not health.
   */
  failingJobs: { windowHours: number; queues: FailingQueue[] } | null;
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
  };
}

export interface AdminSettings {
  registrationEnabled: boolean;
  // v1.23 — instance-wide "require a second factor" policy.
  mfaRequired: boolean;
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
  /** A report left this host successfully inside the delivery window. */
  glitchtipReportsDelivering: boolean;
  /** A report has left this host successfully at some point. */
  glitchtipEverDelivered: boolean;
  /**
   * Why the last attempt failed, when that failure is newer than the last
   * success. A short classification, never a remote response body.
   */
  glitchtipLastFailureReason: string | null;
  /** How long a successful send stands for before the badge stops claiming it. */
  glitchtipDeliveryWindowHours: number;
  reminderLateMinutes: number;
  reminderMissedMinutes: number;
  // v1.4.25 W7 — null means "fall back to Europe/Berlin in the resolver".
  defaultUserTimezone: string | null;
  // Document vault — the two admin-tunable limits (bytes on the wire; the
  // UI edits them as MB / GB). The per-file cap clamps to the hard 100 MiB
  // ceiling server-side.
  documentMaxFileBytes: number;
  documentQuotaBytes: number;
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

/** Shared green "configured" pill — the GlitchTip, Umami, and Web-Push
 * VAPID cards all surface the same state; one component keeps the tint
 * and copy in lockstep. */
export function ConfiguredBadge() {
  const { t } = useTranslations();
  return (
    <Badge className="border-success/30 bg-success/15 text-success">
      {t("admin.configured")}
    </Badge>
  );
}

/** The meaning a status tile's value carries. */
export type StatusTone = "success" | "warning" | "destructive";

/**
 * Tone → classes for a status tile's value line.
 *
 * `--success` and `--warning` clear AA as text on the tile's `bg-muted/50`
 * surface, so they tint the wording directly. `--destructive` does not: it is
 * AA on the card itself (4.85:1 in the light theme) but the tile paints a
 * muted wash over that card, and the tinted value measures 3.97:1 there —
 * under the 4.5:1 floor. That is what axe reports on `/admin` whenever the
 * process serving the page is not the worker and the worker row goes red.
 *
 * So the destructive tone takes the shape the other status rows already use
 * (the medication detail status row, the invite-token chips): the token
 * paints a small indicator and the wording stays in `text-foreground`. The
 * word itself ("Stopped", "Error") states the condition, so nothing hangs on
 * the colour alone.
 */
const STATUS_TONE_CLASS: Record<StatusTone, string> = {
  success: "text-success",
  warning: "text-warning",
  destructive: "text-foreground",
};

/**
 * The console's label/value tile. Four hand-rolled variants of this box used
 * to exist side by side; `StatTile` is the one, and this is the thin adapter
 * the status grids call (the `tone` they pass decides how the VALUE reads,
 * which is why it cannot just be `StatTile` under a different name).
 */
export function StatusItem({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  tone?: StatusTone;
}) {
  return (
    <StatTile
      icon={icon}
      label={label}
      value={
        tone === "destructive" ? (
          <span className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              data-slot="status-item-indicator"
              className="bg-destructive size-2 shrink-0 rounded-full"
            />
            {value}
          </span>
        ) : (
          value
        )
      }
      valueClassName={tone ? STATUS_TONE_CLASS[tone] : undefined}
    />
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
        // The visible label is a sibling `<p>` with no association to the
        // Radix switch button, so a screen reader would announce a bare
        // "switch, on/off". Name it explicitly — one fix covers every admin
        // toggle that mounts this shared component.
        aria-label={label}
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
      return apiGet<AdminSettings>("/api/admin/settings");
    },
  });
}

export function useUpdateSettings() {
  const queryClient = useQueryClient();
  const { t } = useTranslations();
  return useMutation({
    mutationFn: async (data: Record<string, unknown>) => {
      await apiPut("/api/admin/settings", data);
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
  "password" | "passkey" | "api_token" | "withings" | "unknown";

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
 * pure unit test without rendering the React tree. The maintainer's spec pins
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
      return apiGet<SystemStatus>("/api/admin/status");
    },
  });
}

/** Helpful-rate tint shared by the AI-quality + Coach-feedback tables.
 * The standard urgency ramp (the medication-status-pill precedent):
 * ≥80 % success, ≥50 % warning, below destructive — a sub-50 % helpful
 * rate is a genuine quality alarm, and the percent label always carries
 * the exact value alongside the tint. */
export function helpfulRateColour(rate: number): string {
  if (rate >= 0.8) return "text-success";
  if (rate >= 0.5) return "text-warning";
  return "text-destructive";
}

export interface PublicVersion {
  version: string;
  buildSha: string | null;
  builtAt: string | null;
  offlineGeoEnabled?: boolean;
  // Host of the online geo provider the runtime falls back to when the
  // offline tier is absent (host of IP_GEO_LOOKUP_URL, default ipwho.is).
  // Optional so legacy /api/version responses still satisfy the shape.
  geoProviderHost?: string;
}

/** Shared `/api/version` reader — the system-status section + overview
 * summary both surface app version / build SHA / offline-geo state. */
export function usePublicVersion() {
  return useQuery({
    queryKey: queryKeys.publicVersion(),
    queryFn: async () => {
      return apiGet<PublicVersion>("/api/version");
    },
    staleTime: 5 * 60_000,
  });
}
