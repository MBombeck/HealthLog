"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import {
  Users,
  Plug,
  Activity,
  Database,
  Wrench,
  ScrollText,
  ArrowRight,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type {
  StatusOverview,
  StatusSeverity,
} from "@/app/api/admin/status-overview/route";

/**
 * §2.6 status taxonomy. Renders a colored dot AND a label so we never
 * lean on color alone (WCAG 1.4.1).
 */
const SEVERITY_LABEL: Record<StatusSeverity, string> = {
  good: "Healthy",
  info: "Up to date",
  caution: "Attention",
  alert: "Action required",
  pending: "Loading",
};

const SEVERITY_COLOR: Record<StatusSeverity, string> = {
  good: "var(--dracula-green)",
  info: "var(--dracula-cyan)",
  caution: "var(--dracula-orange)",
  alert: "var(--dracula-red)",
  pending: "var(--muted-foreground)",
};

export function StatusBadge({
  severity,
  label,
}: {
  severity: StatusSeverity;
  label?: string;
}) {
  const text = label ?? SEVERITY_LABEL[severity];
  return (
    <span
      className="bg-muted/40 inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium"
      aria-label={`Status: ${text}`}
    >
      <span
        aria-hidden="true"
        className="inline-block h-2 w-2 rounded-full"
        style={{ backgroundColor: SEVERITY_COLOR[severity] }}
      />
      <span>{text}</span>
    </span>
  );
}

interface StatusCardProps {
  title: string;
  icon: React.ReactNode;
  severity: StatusSeverity;
  metrics: Array<{ label: string; value: string | number }>;
  href: string;
  cta: string;
}

function StatusCard({
  title,
  icon,
  severity,
  metrics,
  href,
  cta,
}: StatusCardProps) {
  return (
    <Card className="flex flex-col gap-2">
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
        <CardTitle className="flex items-center gap-2 text-base font-medium">
          <span aria-hidden="true" className="text-muted-foreground">
            {icon}
          </span>
          {title}
        </CardTitle>
        <StatusBadge severity={severity} />
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <dl className="grid grid-cols-3 gap-2">
          {metrics.map((m) => (
            <div key={m.label} className="flex flex-col gap-0.5">
              <dt className="text-muted-foreground text-xs">{m.label}</dt>
              <dd className="font-mono text-sm tabular-nums">{m.value}</dd>
            </div>
          ))}
        </dl>
        <Link
          href={href}
          className="text-primary inline-flex items-center gap-1 self-start text-sm hover:underline"
        >
          {cta}
          <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
        </Link>
      </CardContent>
    </Card>
  );
}

function fmtRelative(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}

function fmtUptime(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

/**
 * Build the 6 admin status cards from the aggregator response. Pure;
 * no data fetching here — easy to unit test.
 */
export function buildCards(data: StatusOverview): StatusCardProps[] {
  return [
    {
      title: "Users",
      icon: <Users className="h-4 w-4" />,
      severity: data.users.severity,
      metrics: [
        { label: "Total", value: data.users.total },
        { label: "Admins", value: data.users.admins },
        { label: "New 7d", value: data.users.newThisWeek },
      ],
      href: "/admin/users",
      cta: "Manage users",
    },
    {
      title: "Integrations",
      icon: <Plug className="h-4 w-4" />,
      severity: data.integrations.severity,
      metrics: [
        { label: "Withings", value: data.integrations.withings },
        { label: "moodLog", value: data.integrations.moodLog },
        { label: "Push", value: data.integrations.webPush },
      ],
      href: "/admin#integrations",
      cta: "Configure",
    },
    {
      title: "Monitoring",
      icon: <Activity className="h-4 w-4" />,
      severity: data.monitoring.severity,
      metrics: [
        {
          label: "GlitchTip",
          value: data.monitoring.glitchtipEnabled ? "On" : "Off",
        },
        {
          label: "Umami",
          value: data.monitoring.umamiEnabled ? "On" : "Off",
        },
        { label: "Last err", value: fmtRelative(data.monitoring.lastErrorAt) },
      ],
      href: "/admin#monitoring",
      cta: "View monitoring",
    },
    {
      title: "Backups",
      icon: <Database className="h-4 w-4" />,
      severity: data.backups.severity,
      metrics: [
        { label: "Last", value: fmtRelative(data.backups.lastBackupAt) },
        { label: "Users", value: data.backups.backedUpUsers },
        { label: "Retain", value: `${data.backups.retentionDays}d` },
      ],
      href: "/admin#backups",
      cta: "View backups",
    },
    {
      title: "Maintenance",
      icon: <Wrench className="h-4 w-4" />,
      severity: data.maintenance.severity,
      metrics: [
        {
          label: "Worker",
          value: data.maintenance.workerRunning ? "Running" : "Stopped",
        },
        {
          label: "Uptime",
          value: fmtUptime(data.maintenance.workerUptimeSeconds),
        },
        {
          label: "Cleanup",
          value: fmtRelative(data.maintenance.lastIdempotencyCleanup),
        },
      ],
      href: "/admin#maintenance",
      cta: "View jobs",
    },
    {
      title: "Audit log",
      icon: <ScrollText className="h-4 w-4" />,
      severity: data.auditLog.severity,
      metrics: [
        { label: "Events 30d", value: data.auditLog.eventsLast30d },
        { label: "Last login", value: fmtRelative(data.auditLog.lastLoginAt) },
        { label: "—", value: "" },
      ],
      href: "/admin/audit-log",
      cta: "Open viewer",
    },
  ];
}

export function StatusCardGrid() {
  const { data, isLoading } = useQuery<StatusOverview>({
    queryKey: ["admin", "status-overview"],
    queryFn: async () => {
      const res = await fetch("/api/admin/status-overview");
      if (!res.ok) throw new Error("Failed to load admin status overview");
      const json = (await res.json()) as { data: StatusOverview };
      return json.data;
    },
    staleTime: 30_000,
  });

  if (isLoading || !data) {
    return (
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-36 w-full" />
        ))}
      </div>
    );
  }

  const cards = buildCards(data);
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      {cards.map((c) => (
        <StatusCard key={c.title} {...c} />
      ))}
    </div>
  );
}
