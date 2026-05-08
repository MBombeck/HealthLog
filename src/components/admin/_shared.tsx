"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useTranslations } from "@/lib/i18n/context";

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
  reminderLateMinutes: number;
  reminderMissedMinutes: number;
}

export interface AdminAuditEntry {
  id: string;
  action: string;
  ipAddress: string | null;
  location: string | null;
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

export function PasswordInput(props: React.ComponentProps<typeof Input>) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <Input {...props} type={visible ? "text" : "password"} />
      <button
        type="button"
        tabIndex={-1}
        onClick={() => setVisible((v) => !v)}
        className="text-muted-foreground hover:text-foreground absolute top-1/2 right-3 -translate-y-1/2"
      >
        {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  );
}

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
  description: string;
  icon?: React.ComponentType<{ className?: string }>;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2">
        {Icon && <Icon className="text-muted-foreground h-4 w-4" />}
        <div>
          <p className="text-sm font-medium">{label}</p>
          <p className="text-muted-foreground text-xs">{description}</p>
        </div>
      </div>
      <Switch
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
      />
    </div>
  );
}

export function useAdminSettings() {
  return useQuery({
    queryKey: ["admin", "settings"],
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
      queryClient.invalidateQueries({ queryKey: ["admin", "settings"] });
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

export function useSystemStatus() {
  return useQuery({
    queryKey: ["admin", "status"],
    queryFn: async () => {
      const res = await fetch("/api/admin/status");
      if (!res.ok) throw new Error("Failed");
      return (await res.json()).data as SystemStatus;
    },
  });
}
