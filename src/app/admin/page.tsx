"use client";

import { useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Shield,
  Users,
  Settings,
  Loader2,
  KeyRound,
  Pencil,
  AlertTriangle,
  Trash2,
  Activity,
  Database,
  Server,
  ScrollText,
  ChevronDown,
  XCircle,
  CheckCircle2,
  Eye,
  EyeOff,
  Clock,
  GitCommit,
  Globe,
  MessageCircle,
  Bell,
  BellRing,
  Key,
} from "lucide-react";
import { PasswordStrength } from "@/components/ui/password-strength";
import { formatDate, formatDateTime } from "@/lib/format";
import { useTranslations } from "@/lib/i18n/context";
import { toast } from "sonner";

function PasswordInput(props: React.ComponentProps<typeof Input>) {
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

interface AdminUser {
  id: string;
  username: string;
  email: string | null;
  role: string;
  createdAt: string;
  passkeyCount: number;
}

interface SystemStatus {
  version: string;
  nodeVersion: string;
  gitCommit: string;
  buildTime: string;
  startTime: string;
  database: string;
  counts: {
    users: number;
    measurements: number;
    medications: number;
    intakeEvents: number;
    activeTokens: number;
    activeSessions: number;
  };
}

interface AdminSettings {
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

export default function AdminPage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { t } = useTranslations();

  if (!user || user.role !== "ADMIN") return null;

  const adminSections = [
    { id: "section-system-status", label: t("admin.systemStatus") },
    { id: "section-admin-general", label: t("admin.appSettings") },
    { id: "section-admin-services", label: t("admin.servicesGlobal") },
    { id: "section-admin-monitoring", label: t("admin.monitoring") },
    { id: "section-admin-bugreport", label: t("admin.bugReportGithub") },
    { id: "section-admin-reminders", label: t("admin.medicationReminders") },
    { id: "section-user-management", label: t("admin.userManagement") },
    { id: "section-api-tokens", label: t("admin.apiTokens") },
    { id: "section-login-overview", label: t("admin.loginOverview") },
    { id: "section-danger-zone", label: t("admin.dangerZone") },
  ];

  function scrollToSection(id: string) {
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">
          {t("admin.title")}
        </h1>
        <p className="text-muted-foreground text-sm">{t("admin.subtitle")}</p>
      </div>

      <div className="relative">
        <aside className="fixed top-24 left-[calc((100vw-76.8rem)/2-14rem)] hidden max-h-[calc(100vh-7rem)] w-48 overflow-y-auto 2xl:block">
          <p className="text-foreground/60 text-xs font-semibold tracking-wider uppercase">
            {t("admin.sectionsTitle")}
          </p>
          <nav className="mt-2 space-y-0.5">
            {adminSections.map((section) => {
              const isDanger = section.id === "section-danger-zone";
              return (
                <button
                  key={section.id}
                  onClick={() => scrollToSection(section.id)}
                  className={`w-full px-0 py-1 text-left text-sm transition-colors ${
                    isDanger
                      ? "text-foreground hover:text-destructive"
                      : "text-foreground hover:text-primary"
                  }`}
                >
                  {section.label}
                </button>
              );
            })}
          </nav>
        </aside>

        <div className="space-y-6">
          <SystemStatusSection id="section-system-status" />
          <AppSettingsSection
            ids={{
              general: "section-admin-general",
              services: "section-admin-services",
              monitoring: "section-admin-monitoring",
              bugReport: "section-admin-bugreport",
              reminders: "section-admin-reminders",
            }}
          />
          <UserManagementSection
            id="section-user-management"
            queryClient={queryClient}
            currentUserId={user.id}
          />
          <ApiTokenOverviewSection id="section-api-tokens" />
          <LoginOverviewSection id="section-login-overview" />
          <DangerZoneSection id="section-danger-zone" />
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────── System Status ─────────────────────── */

function SystemStatusSection({ id }: { id: string }) {
  const { t } = useTranslations();

  const { data: status } = useQuery({
    queryKey: ["admin", "status"],
    queryFn: async () => {
      const res = await fetch("/api/admin/status");
      if (!res.ok) throw new Error("Failed");
      return (await res.json()).data as SystemStatus;
    },
  });

  return (
    <div id={id} className="bg-card border-border scroll-mt-28 rounded-xl border p-6">
      <div className="flex items-center gap-2">
        <Server className="text-primary h-5 w-5" />
        <h2 className="text-lg font-semibold">{t("admin.systemStatus")}</h2>
      </div>
      {status ? (
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatusItem
            icon={Activity}
            label={t("admin.version")}
            value={`v${status.version}`}
          />
          <StatusItem
            icon={Database}
            label={t("admin.database")}
            value={
              status.database === "connected"
                ? t("admin.databaseConnected")
                : t("admin.databaseError")
            }
            className={
              status.database === "connected"
                ? "text-dracula-green"
                : "text-destructive"
            }
          />
          <StatusItem
            icon={GitCommit}
            label={t("admin.gitCommit")}
            value={status.gitCommit}
            className="font-mono"
          />
          <StatusItem
            icon={Clock}
            label={t("admin.startedAt")}
            value={formatDateTime(status.startTime)}
          />
          <StatusItem
            icon={Users}
            label={t("admin.users")}
            value={String(status.counts.users)}
          />
          <StatusItem
            icon={Activity}
            label={t("admin.measurementsCount")}
            value={status.counts.measurements.toLocaleString("de-DE")}
          />
          <StatusItem
            icon={Key}
            label={t("admin.activeTokens")}
            value={String(status.counts.activeTokens)}
          />
          <StatusItem
            icon={Globe}
            label={t("admin.activeSessions")}
            value={String(status.counts.activeSessions)}
          />
        </div>
      ) : (
        <div className="mt-4 flex items-center gap-2">
          <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />
          <span className="text-muted-foreground text-sm">
            {t("admin.loadingStatus")}
          </span>
        </div>
      )}
    </div>
  );
}

function StatusItem({
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

function Separator() {
  return <div className="border-border border-t" />;
}

/* ─────────────────────── App Settings ─────────────────────── */

function AppSettingsSection({
  ids,
}: {
  ids: {
    general: string;
    services: string;
    monitoring: string;
    bugReport: string;
    reminders: string;
  };
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [bugReportRepoDraft, setBugReportRepoDraft] = useState<string | null>(
    null,
  );
  const [bugReportTokenDraft, setBugReportTokenDraft] = useState("");
  const [umamiScriptUrlDraft, setUmamiScriptUrlDraft] = useState<string | null>(
    null,
  );
  const [umamiWebsiteIdDraft, setUmamiWebsiteIdDraft] = useState<string | null>(
    null,
  );
  const [glitchtipDsnDraft, setGlitchtipDsnDraft] = useState<string | null>(
    null,
  );
  const [glitchtipEnvironmentDraft, setGlitchtipEnvironmentDraft] = useState<
    string | null
  >(null);
  const [webPushVapidPublicKeyDraft, setWebPushVapidPublicKeyDraft] =
    useState<string | null>(null);
  const [webPushVapidPrivateKeyDraft, setWebPushVapidPrivateKeyDraft] =
    useState("");
  const [webPushVapidSubjectDraft, setWebPushVapidSubjectDraft] = useState<
    string | null
  >(null);
  const [reminderLateDraft, setReminderLateDraft] = useState<number | null>(null);
  const [reminderMissedDraft, setReminderMissedDraft] = useState<number | null>(null);

  const { data: settings } = useQuery({
    queryKey: ["admin", "settings"],
    queryFn: async () => {
      const res = await fetch("/api/admin/settings");
      if (!res.ok) throw new Error("Failed");
      return (await res.json()).data as AdminSettings;
    },
  });

  const updateSettings = useMutation({
    mutationFn: async (data: Record<string, unknown>) => {
      const res = await fetch("/api/admin/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Failed");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "settings"] });
    },
  });

  async function getApiErrorMessage(response: Response): Promise<string> {
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

  const testUmami = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/admin/monitoring/umami-test", {
        method: "POST",
      });
      if (!res.ok) {
        throw new Error(await getApiErrorMessage(res));
      }
      const json = (await res.json()) as { data?: { message?: string } };
      return json.data?.message ?? t("admin.monitoringTestSuccess");
    },
    onSuccess: (message) => {
      toast.success(message);
    },
    onError: (error) => {
      toast.error(
        error instanceof Error
          ? error.message
          : t("admin.monitoringTestFailed"),
      );
    },
  });

  const testGlitchtip = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/admin/monitoring/glitchtip-test", {
        method: "POST",
      });
      if (!res.ok) {
        throw new Error(await getApiErrorMessage(res));
      }
      const json = (await res.json()) as { data?: { message?: string } };
      return json.data?.message ?? t("admin.monitoringTestSuccess");
    },
    onSuccess: (message) => {
      toast.success(message);
    },
    onError: (error) => {
      toast.error(
        error instanceof Error
          ? error.message
          : t("admin.monitoringTestFailed"),
      );
    },
  });

  const testNotification = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/admin/notifications/test", {
        method: "POST",
      });
      if (!res.ok) {
        throw new Error(await getApiErrorMessage(res));
      }
      const json = (await res.json()) as {
        data?: {
          message?: string;
          results?: Array<{
            channel: string;
            success: boolean;
            error?: string;
          }>;
        };
      };
      return json.data;
    },
    onSuccess: (data) => {
      const hasFailures = data?.results?.some((r) => !r.success);
      if (hasFailures) {
        toast.error(data?.message ?? t("admin.notificationTestFailed"));
      } else {
        toast.success(data?.message ?? t("admin.notificationTestSuccess"));
      }
    },
    onError: (error) => {
      toast.error(
        error instanceof Error
          ? error.message
          : t("admin.notificationTestFailed"),
      );
    },
  });

  const reminderCheck = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/admin/notifications/reminder-check", {
        method: "POST",
      });
      if (!res.ok) {
        throw new Error(await getApiErrorMessage(res));
      }
      const json = (await res.json()) as {
        data?: {
          message?: string;
          medications?: Array<{
            name: string;
            dose: string;
            user: string;
            localTime: string;
            dayOfWeek: string;
            notificationsEnabled: boolean;
            schedules: Array<{
              window: string;
              days: string;
              status: string;
              label: string;
              notificationSent?: boolean;
            }>;
            eventsToday: number;
          }>;
          notificationsSent?: number;
        };
      };
      return json.data;
    },
    onSuccess: (data) => {
      toast.success(data?.message ?? t("admin.reminderCheckSuccess"));
    },
    onError: (error) => {
      toast.error(
        error instanceof Error
          ? error.message
          : t("admin.reminderCheckFailed"),
      );
    },
  });

  const bugReportRepoValue = bugReportRepoDraft ?? settings?.bugReportRepo ?? "";
  const umamiScriptUrlValue =
    umamiScriptUrlDraft ?? settings?.umamiScriptUrl ?? "";
  const umamiWebsiteIdValue = umamiWebsiteIdDraft ?? settings?.umamiWebsiteId ?? "";
  const glitchtipDsnValue = glitchtipDsnDraft ?? settings?.glitchtipDsn ?? "";
  const glitchtipEnvironmentValue =
    glitchtipEnvironmentDraft ?? settings?.glitchtipEnvironment ?? "production";
  const webPushVapidPublicKeyValue =
    webPushVapidPublicKeyDraft ?? settings?.webPushVapidPublicKey ?? "";
  const webPushVapidSubjectValue =
    webPushVapidSubjectDraft ?? settings?.webPushVapidSubject ?? "";

  function saveBugReportSettings() {
    const payload: Record<string, unknown> = {
      bugReportRepo: bugReportRepoValue,
    };
    if (bugReportTokenDraft.trim().length > 0) {
      payload.bugReportToken = bugReportTokenDraft.trim();
    }

    updateSettings.mutate(payload, {
      onSuccess: () => {
        setBugReportRepoDraft(null);
        setBugReportTokenDraft("");
      },
    });
  }

  function saveMonitoringSettings() {
    const payload: Record<string, unknown> = {
      umamiScriptUrl: umamiScriptUrlValue,
      umamiWebsiteId: umamiWebsiteIdValue,
      glitchtipDsn: glitchtipDsnValue,
      glitchtipEnvironment: glitchtipEnvironmentValue,
      webPushVapidPublicKey: webPushVapidPublicKeyValue,
      webPushVapidSubject: webPushVapidSubjectValue,
    };
    if (webPushVapidPrivateKeyDraft.trim().length > 0) {
      payload.webPushVapidPrivateKey = webPushVapidPrivateKeyDraft.trim();
    }

    updateSettings.mutate(payload, {
      onSuccess: () => {
        setUmamiScriptUrlDraft(null);
        setUmamiWebsiteIdDraft(null);
        setGlitchtipDsnDraft(null);
        setGlitchtipEnvironmentDraft(null);
        setWebPushVapidPublicKeyDraft(null);
        setWebPushVapidPrivateKeyDraft("");
        setWebPushVapidSubjectDraft(null);
      },
    });
  }

  function saveUmamiSettings() {
    updateSettings.mutate(
      {
        umamiScriptUrl: umamiScriptUrlValue,
        umamiWebsiteId: umamiWebsiteIdValue,
      },
      {
        onSuccess: () => {
          setUmamiScriptUrlDraft(null);
          setUmamiWebsiteIdDraft(null);
        },
      },
    );
  }

  return (
    <div id={ids.general} className="bg-card border-border scroll-mt-28 rounded-xl border p-6">
      <div className="flex items-center gap-2">
        <Settings className="text-primary h-5 w-5" />
        <h2 className="text-lg font-semibold">{t("admin.appSettings")}</h2>
      </div>
      <div className="mt-4 space-y-4">
        {/* Registration toggle */}
        <SettingsToggle
          label={t("admin.registrationEnabled")}
          description={t("admin.registrationEnabledDescription")}
          checked={settings?.registrationEnabled ?? true}
          onCheckedChange={(checked) =>
            updateSettings.mutate({ registrationEnabled: checked })
          }
          disabled={updateSettings.isPending}
        />

        <Separator />

        {/* Default locale */}
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">{t("admin.defaultLanguage")}</p>
            <p className="text-muted-foreground text-xs">
              {t("admin.defaultLanguageDescription")}
            </p>
          </div>
          <select
            value={settings?.defaultLocale ?? "de"}
            onChange={(e) =>
              updateSettings.mutate({ defaultLocale: e.target.value })
            }
            disabled={updateSettings.isPending}
            className="border-input bg-background text-foreground ring-offset-background focus-visible:ring-ring flex h-9 rounded-md border px-3 py-1 text-sm shadow-xs transition-[color,box-shadow] focus-visible:ring-[3px] focus-visible:outline-none"
          >
            <option value="de">Deutsch</option>
            <option value="en">English</option>
          </select>
        </div>

        <Separator />

        {/* Service toggles */}
        <div id={ids.services} className="scroll-mt-28">
          <p className="mb-3 text-sm font-medium">
            {t("admin.servicesGlobal")}
          </p>
          <p className="text-muted-foreground mb-3 text-xs">
            {t("admin.servicesGlobalDescription")}
          </p>
          <div className="space-y-3">
            <SettingsToggle
              label="Telegram"
              description={t("admin.telegramGlobal")}
              icon={MessageCircle}
              checked={settings?.telegramGlobal ?? true}
              onCheckedChange={(checked) =>
                updateSettings.mutate({ telegramGlobal: checked })
              }
              disabled={updateSettings.isPending}
            />
            <SettingsToggle
              label="ntfy"
              description={t("admin.ntfyGlobal")}
              icon={Bell}
              checked={settings?.ntfyGlobal ?? true}
              onCheckedChange={(checked) =>
                updateSettings.mutate({ ntfyGlobal: checked })
              }
              disabled={updateSettings.isPending}
            />
            <SettingsToggle
              label="Web Push"
              description={t("admin.webPushGlobal")}
              icon={Globe}
              checked={settings?.webPushGlobal ?? true}
              onCheckedChange={(checked) =>
                updateSettings.mutate({ webPushGlobal: checked })
              }
              disabled={updateSettings.isPending}
            />
            <SettingsToggle
              label="API"
              description={t("admin.apiGlobal")}
              icon={Key}
              checked={settings?.apiGlobal ?? true}
              onCheckedChange={(checked) =>
                updateSettings.mutate({ apiGlobal: checked })
              }
              disabled={updateSettings.isPending}
            />
          </div>
        </div>

        <Separator />

        <div id={ids.monitoring} className="scroll-mt-28 space-y-4">
          <div>
            <p className="text-sm font-medium">{t("admin.monitoring")}</p>
            <p className="text-muted-foreground text-xs">
              {t("admin.monitoringDescription")}
            </p>
          </div>

          <div className="space-y-3 rounded-lg border border-white/10 p-3">
            <SettingsToggle
              label="Umami"
              description={t("admin.umamiEnabled")}
              icon={Activity}
              checked={settings?.umamiEnabled ?? false}
              onCheckedChange={(checked) =>
                updateSettings.mutate({ umamiEnabled: checked })
              }
              disabled={updateSettings.isPending}
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="admin-umami-script-url" className="text-xs">
                  {t("admin.umamiScriptUrl")}
                </Label>
                <Input
                  id="admin-umami-script-url"
                  name="admin-umami-script-url"
                  value={umamiScriptUrlValue}
                  onChange={(event) =>
                    setUmamiScriptUrlDraft(event.target.value)
                  }
                  placeholder={t("admin.umamiScriptUrlPlaceholder")}
                  autoComplete="new-password"
                  spellCheck={false}
                  data-lpignore="true"
                  data-1p-ignore="true"
                  disabled={updateSettings.isPending}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="admin-umami-website-id" className="text-xs">
                  {t("admin.umamiWebsiteId")}
                </Label>
                <Input
                  id="admin-umami-website-id"
                  name="admin-umami-website-id"
                  value={umamiWebsiteIdValue}
                  onChange={(event) =>
                    setUmamiWebsiteIdDraft(event.target.value)
                  }
                  placeholder={t("admin.umamiWebsiteIdPlaceholder")}
                  autoComplete="new-password"
                  spellCheck={false}
                  data-lpignore="true"
                  data-1p-ignore="true"
                  disabled={updateSettings.isPending}
                />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button
                size="sm"
                onClick={saveUmamiSettings}
                disabled={updateSettings.isPending}
              >
                {updateSettings.isPending && (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                )}
                {t("admin.monitoringSave")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => testUmami.mutate()}
                disabled={testUmami.isPending || updateSettings.isPending}
              >
                {testUmami.isPending && (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                )}
                {t("admin.monitoringTestUmami")}
              </Button>
            </div>
          </div>

          <div className="space-y-3 rounded-lg border border-white/10 p-3">
            <SettingsToggle
              label="Glitchtip"
              description={t("admin.glitchtipEnabled")}
              icon={AlertTriangle}
              checked={settings?.glitchtipEnabled ?? false}
              onCheckedChange={(checked) =>
                updateSettings.mutate({ glitchtipEnabled: checked })
              }
              disabled={updateSettings.isPending}
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="admin-glitchtip-dsn" className="text-xs">
                  {t("admin.glitchtipDsn")}
                </Label>
                <Input
                  id="admin-glitchtip-dsn"
                  name="admin-glitchtip-dsn"
                  value={glitchtipDsnValue}
                  onChange={(event) => setGlitchtipDsnDraft(event.target.value)}
                  placeholder={t("admin.glitchtipDsnPlaceholder")}
                  autoComplete="new-password"
                  spellCheck={false}
                  data-lpignore="true"
                  data-1p-ignore="true"
                  disabled={updateSettings.isPending}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="admin-glitchtip-environment" className="text-xs">
                  {t("admin.glitchtipEnvironment")}
                </Label>
                <Input
                  id="admin-glitchtip-environment"
                  name="admin-glitchtip-environment"
                  value={glitchtipEnvironmentValue}
                  onChange={(event) =>
                    setGlitchtipEnvironmentDraft(event.target.value)
                  }
                  placeholder={t("admin.glitchtipEnvironmentPlaceholder")}
                  autoComplete="new-password"
                  spellCheck={false}
                  data-lpignore="true"
                  data-1p-ignore="true"
                  disabled={updateSettings.isPending}
                />
              </div>
            </div>
            <div className="flex justify-end">
              <Button
                size="sm"
                variant="outline"
                onClick={() => testGlitchtip.mutate()}
                disabled={testGlitchtip.isPending || updateSettings.isPending}
              >
                {testGlitchtip.isPending && (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                )}
                {t("admin.monitoringTestGlitchtip")}
              </Button>
            </div>
          </div>

          <div className="space-y-3 rounded-lg border border-white/10 p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <BellRing className="text-muted-foreground h-4 w-4" />
                <p className="text-sm font-medium">{t("admin.webPushVapid")}</p>
              </div>
              {settings?.webPushVapidConfigured ? (
                <Badge className="border-dracula-green/30 bg-dracula-green/15 text-dracula-green">
                  {t("admin.configured")}
                </Badge>
              ) : (
                <Badge variant="outline">{t("admin.notConfigured")}</Badge>
              )}
            </div>
            <p className="text-muted-foreground text-xs">
              {t("admin.webPushVapidDescription")}
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="admin-web-push-public-key" className="text-xs">
                  {t("admin.webPushVapidPublicKey")}
                </Label>
                <Input
                  id="admin-web-push-public-key"
                  name="admin-web-push-public-key"
                  value={webPushVapidPublicKeyValue}
                  onChange={(event) =>
                    setWebPushVapidPublicKeyDraft(event.target.value)
                  }
                  placeholder={t("admin.webPushVapidPublicKeyPlaceholder")}
                  autoComplete="new-password"
                  spellCheck={false}
                  data-lpignore="true"
                  data-1p-ignore="true"
                  disabled={updateSettings.isPending}
                />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="admin-web-push-private-key" className="text-xs">
                  {t("admin.webPushVapidPrivateKey")}
                </Label>
                <PasswordInput
                  id="admin-web-push-private-key"
                  name="admin-web-push-private-key"
                  value={webPushVapidPrivateKeyDraft}
                  onChange={(event) =>
                    setWebPushVapidPrivateKeyDraft(event.target.value)
                  }
                  placeholder={t("admin.webPushVapidPrivateKeyPlaceholder")}
                  autoComplete="new-password"
                  spellCheck={false}
                  data-lpignore="true"
                  data-1p-ignore="true"
                  disabled={updateSettings.isPending}
                />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="admin-web-push-subject" className="text-xs">
                  {t("admin.webPushVapidSubject")}
                </Label>
                <Input
                  id="admin-web-push-subject"
                  name="admin-web-push-subject"
                  value={webPushVapidSubjectValue}
                  onChange={(event) =>
                    setWebPushVapidSubjectDraft(event.target.value)
                  }
                  placeholder={t("admin.webPushVapidSubjectPlaceholder")}
                  autoComplete="new-password"
                  spellCheck={false}
                  data-lpignore="true"
                  data-1p-ignore="true"
                  disabled={updateSettings.isPending}
                />
              </div>
            </div>
          </div>

          <div className="flex justify-end">
            <Button
              size="sm"
              onClick={saveMonitoringSettings}
              disabled={updateSettings.isPending}
            >
              {updateSettings.isPending && (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              )}
              {t("admin.monitoringSave")}
            </Button>
          </div>
        </div>

        <Separator />

        <div id={ids.bugReport} className="scroll-mt-28 space-y-3">
          <div>
            <p className="text-sm font-medium">{t("admin.bugReportGithub")}</p>
            <p className="text-muted-foreground text-xs">
              {t("admin.bugReportGithubDescription")}
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="admin-bugreport-repo" className="text-xs">
                {t("admin.bugReportRepo")}
              </Label>
              <Input
                id="admin-bugreport-repo"
                value={bugReportRepoValue}
                onChange={(event) => setBugReportRepoDraft(event.target.value)}
                placeholder={t("admin.bugReportRepoPlaceholder")}
                autoComplete="off"
                data-lpignore="true"
                data-1p-ignore="true"
                disabled={updateSettings.isPending}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="admin-bugreport-token" className="text-xs">
                {t("admin.bugReportToken")}
              </Label>
              <PasswordInput
                id="admin-bugreport-token"
                value={bugReportTokenDraft}
                onChange={(event) => setBugReportTokenDraft(event.target.value)}
                placeholder={t("admin.bugReportTokenPlaceholder")}
                disabled={updateSettings.isPending}
              />
            </div>
          </div>
          <div className="flex items-center justify-between gap-3">
            <p className="text-muted-foreground text-xs">
              {settings?.bugReportConfigured
                ? t("admin.bugReportConfigured")
                : t("admin.bugReportNotConfigured")}
            </p>
            <Button
              size="sm"
              onClick={saveBugReportSettings}
              disabled={updateSettings.isPending}
            >
              {updateSettings.isPending && (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              )}
              {t("admin.bugReportSave")}
            </Button>
          </div>
        </div>

        <Separator />

        {/* ── Medication Reminders ── */}
        <div id={ids.reminders} className="scroll-mt-28 space-y-3">
          <div className="flex items-center gap-2">
            <Clock className="text-muted-foreground h-4 w-4" />
            <div>
              <p className="text-sm font-medium">
                {t("admin.medicationReminders")}
              </p>
              <p className="text-muted-foreground text-xs">
                {t("admin.medicationRemindersDescription")}
              </p>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="admin-reminder-late" className="text-xs">
                {t("admin.reminderLateMinutes")}
              </Label>
              <p className="text-muted-foreground text-xs">
                {t("admin.reminderLateMinutesDescription")}
              </p>
              <Input
                id="admin-reminder-late"
                type="number"
                min={15}
                max={480}
                value={reminderLateDraft ?? settings?.reminderLateMinutes ?? 120}
                onChange={(e) => setReminderLateDraft(Number(e.target.value))}
                autoComplete="off"
                data-lpignore="true"
                data-1p-ignore="true"
                disabled={updateSettings.isPending}
                className="w-32"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="admin-reminder-missed" className="text-xs">
                {t("admin.reminderMissedMinutes")}
              </Label>
              <p className="text-muted-foreground text-xs">
                {t("admin.reminderMissedMinutesDescription")}
              </p>
              <Input
                id="admin-reminder-missed"
                type="number"
                min={30}
                max={720}
                value={reminderMissedDraft ?? settings?.reminderMissedMinutes ?? 240}
                onChange={(e) => setReminderMissedDraft(Number(e.target.value))}
                autoComplete="off"
                data-lpignore="true"
                data-1p-ignore="true"
                disabled={updateSettings.isPending}
                className="w-32"
              />
            </div>
          </div>
          <Button
            size="sm"
            onClick={() => {
              updateSettings.mutate(
                {
                  ...(reminderLateDraft != null && { reminderLateMinutes: reminderLateDraft }),
                  ...(reminderMissedDraft != null && { reminderMissedMinutes: reminderMissedDraft }),
                },
                {
                  onSuccess: () => {
                    setReminderLateDraft(null);
                    setReminderMissedDraft(null);
                  },
                },
              );
            }}
            disabled={updateSettings.isPending || (reminderLateDraft == null && reminderMissedDraft == null)}
          >
            {updateSettings.isPending && (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            )}
            {t("admin.reminderThresholdsSave")}
          </Button>

          <Separator />

          <div className="space-y-3">
            <h4 className="text-sm font-medium">{t("admin.notificationTest")}</h4>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => testNotification.mutate()}
                disabled={testNotification.isPending}
              >
                {testNotification.isPending && (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                )}
                <Bell className="mr-1.5 h-3.5 w-3.5" />
                {t("admin.notificationTestSend")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => reminderCheck.mutate()}
                disabled={reminderCheck.isPending}
              >
                {reminderCheck.isPending && (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                )}
                <Activity className="mr-1.5 h-3.5 w-3.5" />
                {t("admin.reminderCheckRun")}
              </Button>
            </div>

            {testNotification.data?.results && testNotification.data.results.length > 0 && (
              <div className="space-y-1">
                {testNotification.data.results.map((r, i) => (
                  <div key={i} className="text-xs flex items-center gap-1.5">
                    {r.success ? (
                      <CheckCircle2 className="h-3.5 w-3.5 text-green-400 shrink-0" />
                    ) : (
                      <XCircle className="h-3.5 w-3.5 text-red-400 shrink-0" />
                    )}
                    <span className="font-medium">{r.channel}</span>
                    {r.error && (
                      <span className="text-muted-foreground">— {r.error}</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {reminderCheck.data?.medications && reminderCheck.data.medications.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-sm font-medium">{t("admin.reminderCheckResults")}</h4>
              <div className="space-y-2">
                {reminderCheck.data.medications.map((med, i) => (
                  <div
                    key={i}
                    className="bg-muted/50 rounded-lg p-3 space-y-1.5"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium">
                        {med.name} ({med.dose})
                      </span>
                      <Badge variant={med.notificationsEnabled ? "default" : "secondary"}>
                        {med.notificationsEnabled ? t("admin.reminderCheckNotifOn") : t("admin.reminderCheckNotifOff")}
                      </Badge>
                    </div>
                    <p className="text-muted-foreground text-xs">
                      {med.user} — {med.dayOfWeek} {med.localTime} — {t("admin.reminderCheckEventsToday")}: {med.eventsToday}
                    </p>
                    {med.schedules.map((sched, j) => {
                      const statusColor =
                        sched.status === "open"
                          ? "text-green-400"
                          : sched.status === "threshold"
                            ? "text-yellow-400"
                            : sched.status === "missed"
                              ? "text-red-400"
                              : sched.status === "skipped"
                                ? "text-muted-foreground"
                                : "";
                      return (
                        <div key={j} className="text-xs flex items-start gap-1.5">
                          <span className="text-muted-foreground shrink-0">{sched.window}</span>
                          <span className="text-muted-foreground shrink-0">[{sched.days}]</span>
                          <span className={statusColor}>{sched.label}</span>
                          {sched.notificationSent && (
                            <span className="text-green-400 shrink-0 flex items-center gap-0.5">
                              <Bell className="h-3 w-3" />
                              {t("admin.reminderCheckNotifSent")}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SettingsToggle({
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

/* ─────────────────────── Login Overview ─────────────────────── */

interface AdminAuditEntry {
  id: string;
  action: string;
  ipAddress: string | null;
  location: string | null;
  details: string | null;
  createdAt: string;
  user: { id: string; username: string } | null;
}

function LoginOverviewSection({ id }: { id: string }) {
  const { t } = useTranslations();
  const [expanded, setExpanded] = useState(false);
  const [filter, setFilter] = useState<"all" | "failed">("all");

  const AUTH_ACTION_LABELS: Record<string, string> = {
    "auth.register": t("admin.authRegister"),
    "auth.login": t("admin.authLogin"),
    "auth.login.passkey": t("admin.authLoginPasskey"),
    "auth.login.password": t("admin.authLoginPassword"),
    "auth.login.failed": t("admin.authLoginFailed"),
    "auth.logout": t("admin.authLogout"),
    "auth.passkey.register": t("admin.authPasskeyRegister"),
    "auth.passkey.delete": t("admin.authPasskeyDelete"),
  };

  const { data, isLoading } = useQuery({
    queryKey: ["admin", "audit-log", filter],
    queryFn: async () => {
      const res = await fetch(`/api/admin/audit-log?limit=100&filter=auth`);
      if (!res.ok) throw new Error("Failed");
      return (await res.json()).data as {
        entries: AdminAuditEntry[];
        meta: { total: number };
      };
    },
    enabled: expanded,
  });

  const entries =
    filter === "failed"
      ? data?.entries.filter((e) => e.action === "auth.login.failed")
      : data?.entries;

  return (
    <div id={id} className="bg-card border-border scroll-mt-28 rounded-xl border p-6">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ScrollText className="text-primary h-5 w-5" />
          <h2 className="text-lg font-semibold">{t("admin.loginOverview")}</h2>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setExpanded((prev) => !prev)}
          aria-expanded={expanded}
        >
          {expanded ? t("settings.collapse") : t("settings.expand")}
          <ChevronDown
            className={`ml-1 h-4 w-4 transition-transform ${expanded ? "rotate-180" : ""}`}
          />
        </Button>
      </div>

      {expanded && (
        <div className="mt-4 space-y-3">
          <div className="flex gap-1">
            <Button
              variant={filter === "all" ? "default" : "ghost"}
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => setFilter("all")}
            >
              {t("admin.allAuthEvents")}
            </Button>
            <Button
              variant={filter === "failed" ? "default" : "ghost"}
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => setFilter("failed")}
            >
              {t("admin.failedOnly")}
            </Button>
          </div>

          {isLoading ? (
            <div className="flex justify-center py-4">
              <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
            </div>
          ) : !entries?.length ? (
            <p className="text-muted-foreground text-sm">
              {t("admin.noEntries")}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-muted-foreground border-b text-xs">
                    <th className="px-3 py-2 text-left font-medium">
                      {t("admin.status")}
                    </th>
                    <th className="px-3 py-2 text-left font-medium">
                      {t("admin.users")}
                    </th>
                    <th className="px-3 py-2 text-left font-medium">
                      {t("admin.action")}
                    </th>
                    <th className="px-3 py-2 text-right font-medium">
                      {t("admin.ip")}
                    </th>
                    <th className="px-3 py-2 text-right font-medium">
                      {t("admin.location")}
                    </th>
                    <th className="px-3 py-2 text-right font-medium">
                      {t("admin.timestamp")}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-border divide-y">
                  {entries.map((entry, i) => {
                    const isFailed = entry.action === "auth.login.failed";
                    return (
                      <tr
                        key={entry.id}
                        className={i % 2 === 0 ? "bg-muted/30" : ""}
                      >
                        <td className="px-3 py-2">
                          {isFailed ? (
                            <XCircle className="text-destructive h-4 w-4" />
                          ) : (
                            <CheckCircle2 className="text-dracula-green h-4 w-4" />
                          )}
                        </td>
                        <td
                          className={`px-3 py-2 font-medium ${isFailed ? "text-destructive" : ""}`}
                        >
                          {entry.user?.username ?? t("common.unknown")}
                        </td>
                        <td
                          className={`px-3 py-2 text-xs ${isFailed ? "text-destructive" : "text-muted-foreground"}`}
                        >
                          {AUTH_ACTION_LABELS[entry.action] ?? entry.action}
                        </td>
                        <td className="text-muted-foreground px-3 py-2 text-right font-mono text-xs">
                          {entry.ipAddress ?? "—"}
                        </td>
                        <td className="text-muted-foreground px-3 py-2 text-right text-xs">
                          {entry.location ?? "—"}
                        </td>
                        <td className="text-muted-foreground px-3 py-2 text-right text-xs whitespace-nowrap">
                          {formatDateTime(entry.createdAt)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {data && data.meta.total > entries.length && (
                <p className="text-muted-foreground mt-3 text-center text-xs">
                  {t("admin.showingEntries", {
                    count: entries.length,
                    total: data.meta.total,
                  })}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ─────────────────────── API Token Overview ─────────────────────── */

interface ApiTokenInfo {
  id: string;
  name: string;
  permissions: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  revoked: boolean;
  user: { id: string; username: string };
}

function ApiTokenOverviewSection({ id }: { id: string }) {
  const { t } = useTranslations();
  const [expanded, setExpanded] = useState(false);

  const { data: tokens, isLoading } = useQuery({
    queryKey: ["admin", "tokens"],
    queryFn: async () => {
      const res = await fetch("/api/admin/tokens");
      if (!res.ok) throw new Error("Failed");
      return (await res.json()).data as ApiTokenInfo[];
    },
    enabled: expanded,
  });

  return (
    <div id={id} className="bg-card border-border scroll-mt-28 rounded-xl border p-6">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Key className="text-primary h-5 w-5" />
          <h2 className="text-lg font-semibold">{t("admin.apiTokens")}</h2>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setExpanded((prev) => !prev)}
          aria-expanded={expanded}
        >
          {expanded ? t("settings.collapse") : t("settings.expand")}
          <ChevronDown
            className={`ml-1 h-4 w-4 transition-transform ${expanded ? "rotate-180" : ""}`}
          />
        </Button>
      </div>

      {expanded && (
        <div className="mt-4">
          {isLoading ? (
            <div className="flex justify-center py-4">
              <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
            </div>
          ) : !tokens?.length ? (
            <p className="text-muted-foreground text-sm">
              {t("admin.noTokens")}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-muted-foreground border-b text-xs">
                    <th className="px-3 py-2 text-left font-medium">
                      {t("admin.tokenUser")}
                    </th>
                    <th className="px-3 py-2 text-left font-medium">
                      {t("admin.tokenName")}
                    </th>
                    <th className="px-3 py-2 text-left font-medium">
                      {t("admin.tokenPermissions")}
                    </th>
                    <th className="px-3 py-2 text-right font-medium">
                      {t("admin.tokenStatus")}
                    </th>
                    <th className="px-3 py-2 text-right font-medium">
                      {t("admin.tokenLastUsed")}
                    </th>
                    <th className="px-3 py-2 text-right font-medium">
                      {t("admin.tokenCreated")}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-border divide-y">
                  {tokens.map((token, i) => {
                    const isExpired =
                      token.expiresAt && new Date(token.expiresAt) < new Date();
                    return (
                      <tr
                        key={token.id}
                        className={i % 2 === 0 ? "bg-muted/30" : ""}
                      >
                        <td className="px-3 py-2 font-medium">
                          {token.user.username}
                        </td>
                        <td className="px-3 py-2">{token.name}</td>
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap gap-1">
                            {token.permissions.map((p) => (
                              <Badge
                                key={p}
                                variant="secondary"
                                className="text-xs"
                              >
                                {p}
                              </Badge>
                            ))}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-right">
                          {token.revoked ? (
                            <Badge variant="destructive" className="text-xs">
                              {t("settings.tokenRevoked")}
                            </Badge>
                          ) : isExpired ? (
                            <Badge variant="destructive" className="text-xs">
                              {t("settings.tokenExpired")}
                            </Badge>
                          ) : (
                            <Badge className="bg-dracula-green/15 text-dracula-green text-xs">
                              {t("common.active")}
                            </Badge>
                          )}
                        </td>
                        <td className="text-muted-foreground px-3 py-2 text-right text-xs whitespace-nowrap">
                          {token.lastUsedAt
                            ? formatDateTime(token.lastUsedAt)
                            : t("admin.tokenNeverUsed")}
                        </td>
                        <td className="text-muted-foreground px-3 py-2 text-right text-xs whitespace-nowrap">
                          {formatDate(token.createdAt)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ─────────────────────── Danger Zone ─────────────────────── */

function DangerZoneSection({ id }: { id: string }) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [wipeMsg, setWipeMsg] = useState<string | null>(null);

  const wipeAllData = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/admin/data", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: "DELETE ALL" }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || t("common.error"));
      return json.data as {
        measurements: number;
        intakeEvents: number;
        medications: number;
      };
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries();
      setWipeMsg(
        t("admin.deletedResult", {
          measurements: data.measurements,
          medications: data.medications,
          intakeEvents: data.intakeEvents,
        }),
      );
    },
    onError: (err: Error) => {
      setWipeMsg(err.message);
    },
  });

  return (
    <div
      id={id}
      className="bg-destructive/5 border-destructive/30 scroll-mt-28 rounded-xl border p-6"
    >
      <div className="flex items-center gap-2">
        <AlertTriangle className="text-destructive h-5 w-5" />
        <h2 className="text-destructive text-lg font-semibold">
          {t("admin.dangerZone")}
        </h2>
      </div>
      <div className="mt-4">
        <p className="text-sm font-medium">{t("admin.deleteAllData")}</p>
        <p className="text-muted-foreground text-xs">
          {t("admin.deleteAllDescription")}
        </p>
        <div className="mt-3">
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="destructive"
                size="sm"
                disabled={wipeAllData.isPending}
              >
                {wipeAllData.isPending ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Trash2 className="mr-1 h-3.5 w-3.5" />
                )}
                {t("admin.deleteButton")}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {t("admin.deleteAllConfirm")}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {t("admin.deleteAllConfirmDescription")}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  onClick={() => wipeAllData.mutate()}
                >
                  {t("admin.finalDelete")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
        {wipeMsg && (
          <p
            className={`mt-2 text-sm ${wipeMsg.startsWith(t("admin.deletedResult", { measurements: "", medications: "", intakeEvents: "" }).split(":")[0]) ? "text-dracula-green" : "text-destructive"}`}
          >
            {wipeMsg}
          </p>
        )}
      </div>
    </div>
  );
}

/* ─────────────────────── User Management ─────────────────────── */

function UserManagementSection({
  id,
  queryClient,
  currentUserId,
}: {
  id: string;
  queryClient: ReturnType<typeof useQueryClient>;
  currentUserId: string;
}) {
  const { t } = useTranslations();
  const [editingUser, setEditingUser] = useState<AdminUser | null>(null);
  const [editUsername, setEditUsername] = useState("");
  const [editEmail, setEditEmail] = useState("");
  const [resetUser, setResetUser] = useState<AdminUser | null>(null);
  const [resetPassword, setResetPassword] = useState("");
  const [resetMsg, setResetMsg] = useState<string | null>(null);

  const { data: users } = useQuery({
    queryKey: ["admin", "users"],
    queryFn: async () => {
      const res = await fetch("/api/admin/users");
      if (!res.ok) throw new Error("Failed");
      return (await res.json()).data as AdminUser[];
    },
  });

  const updateUser = useMutation({
    mutationFn: async ({
      id,
      data,
    }: {
      id: string;
      data: Record<string, unknown>;
    }) => {
      const res = await fetch(`/api/admin/users/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || t("common.error"));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
      setEditingUser(null);
    },
  });

  const resetPw = useMutation({
    mutationFn: async ({ id, password }: { id: string; password: string }) => {
      const res = await fetch(`/api/admin/users/${id}/reset-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || t("common.error"));
    },
    onSuccess: () => {
      setResetMsg(t("admin.passwordReset"));
      setResetPassword("");
    },
    onError: (err: Error) => {
      setResetMsg(err.message);
    },
  });

  function startEdit(u: AdminUser) {
    setEditingUser(u);
    setEditUsername(u.username);
    setEditEmail(u.email ?? "");
  }

  function startReset(u: AdminUser) {
    setResetUser(u);
    setResetPassword("");
    setResetMsg(null);
  }

  return (
    <div id={id} className="bg-card border-border scroll-mt-28 rounded-xl border p-6">
      <div className="flex items-center gap-2">
        <Users className="text-primary h-5 w-5" />
        <h2 className="text-lg font-semibold">{t("admin.userManagement")}</h2>
        {users && (
          <Badge variant="secondary" className="text-xs">
            {users.length}
          </Badge>
        )}
      </div>

      {users ? (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-muted-foreground border-b text-xs">
                <th className="px-3 py-2 text-left font-medium">
                  {t("admin.users")}
                </th>
                <th className="px-3 py-2 text-left font-medium">
                  {t("admin.userEmail")}
                </th>
                <th className="px-3 py-2 text-center font-medium">
                  {t("admin.userRole")}
                </th>
                <th className="px-3 py-2 text-center font-medium">
                  {t("admin.userPasskeys")}
                </th>
                <th className="px-3 py-2 text-right font-medium">
                  {t("admin.userCreated")}
                </th>
                <th className="px-3 py-2 text-right font-medium">
                  {t("admin.userActions")}
                </th>
              </tr>
            </thead>
            <tbody className="divide-border divide-y">
              {users.map((u, i) => (
                <tr key={u.id} className={i % 2 === 0 ? "bg-muted/30" : ""}>
                  <td className="px-3 py-2 font-medium">{u.username}</td>
                  <td className="text-muted-foreground px-3 py-2 text-xs">
                    {u.email || "—"}
                  </td>
                  <td className="px-3 py-2 text-center">
                    <Badge
                      variant={u.role === "ADMIN" ? "default" : "secondary"}
                      className="text-xs"
                    >
                      {u.role}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 text-center">{u.passkeyCount}</td>
                  <td className="text-muted-foreground px-3 py-2 text-right text-xs whitespace-nowrap">
                    {formatDate(u.createdAt)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        onClick={() =>
                          updateUser.mutate({
                            id: u.id,
                            data: {
                              role: u.role === "ADMIN" ? "USER" : "ADMIN",
                            },
                          })
                        }
                        disabled={u.id === currentUserId}
                        title={
                          u.id === currentUserId
                            ? t("admin.ownRoleUnchangeable")
                            : u.role === "ADMIN"
                              ? t("admin.demoteToUser")
                              : t("admin.promoteToAdmin")
                        }
                      >
                        <Shield className="mr-1 h-3 w-3" />
                        {u.role === "ADMIN"
                          ? t("admin.toUser")
                          : t("admin.toAdmin")}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        onClick={() => startEdit(u)}
                      >
                        <Pencil className="mr-1 h-3 w-3" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        onClick={() => startReset(u)}
                      >
                        <KeyRound className="mr-1 h-3 w-3" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="mt-4 flex items-center gap-2">
          <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />
          <span className="text-muted-foreground text-sm">
            {t("admin.loadingUsers")}
          </span>
        </div>
      )}

      {/* Edit Dialog */}
      {editingUser && (
        <div className="bg-muted/80 mt-4 rounded-lg p-4">
          <h3 className="mb-3 text-sm font-medium">
            {t("admin.editUserTitle", { name: editingUser.username })}
          </h3>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="edit-username">{t("auth.username")}</Label>
              <Input
                id="edit-username"
                value={editUsername}
                onChange={(e) => setEditUsername(e.target.value)}
                autoComplete="off"
                data-lpignore="true"
                data-1p-ignore="true"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="edit-email">{t("admin.userEmail")}</Label>
              <Input
                id="edit-email"
                type="email"
                value={editEmail}
                onChange={(e) => setEditEmail(e.target.value)}
                placeholder={t("common.optional")}
                autoComplete="off"
                data-lpignore="true"
                data-1p-ignore="true"
              />
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={updateUser.isPending}
                onClick={() =>
                  updateUser.mutate({
                    id: editingUser.id,
                    data: {
                      username: editUsername,
                      email: editEmail || null,
                    },
                  })
                }
              >
                {updateUser.isPending && (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                )}
                {t("common.save")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setEditingUser(null)}
              >
                {t("common.cancel")}
              </Button>
              {updateUser.isError && (
                <span className="text-destructive self-center text-sm">
                  {(updateUser.error as Error).message}
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Password Reset Dialog */}
      {resetUser && (
        <div className="bg-muted/80 mt-4 rounded-lg p-4">
          <h3 className="mb-3 text-sm font-medium">
            {t("admin.resetPasswordTitle", { name: resetUser.username })}
          </h3>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="reset-pw">{t("admin.newPassword")}</Label>
              <PasswordInput
                id="reset-pw"
                value={resetPassword}
                onChange={(e) => setResetPassword(e.target.value)}
                placeholder={t("admin.newPasswordPlaceholder")}
              />
              <PasswordStrength password={resetPassword} />
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={resetPw.isPending || !resetPassword}
                onClick={() =>
                  resetPw.mutate({
                    id: resetUser.id,
                    password: resetPassword,
                  })
                }
              >
                {resetPw.isPending && (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                )}
                {t("admin.reset")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setResetUser(null)}
              >
                {t("common.cancel")}
              </Button>
            </div>
            {resetMsg && (
              <p
                className={`text-sm ${resetMsg === t("admin.passwordReset") ? "text-dracula-green" : "text-destructive"}`}
              >
                {resetMsg}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
