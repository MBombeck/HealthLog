"use client";

import Link from "next/link";
import {
  ChevronRight,
  Cloud,
  Fingerprint,
  KeyRound,
  ListChecks,
  Mail,
  MessageCircle,
  Pill,
  Plug,
  ServerCog,
  Shield,
  Sparkles,
  Activity,
  User,
  UserPlus,
  Users,
  Bell,
  Bug,
  Play,
  type LucideIcon,
} from "lucide-react";

import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { pageHref } from "@/lib/links/hrefs";
import { markSetupReturn } from "@/lib/onboarding/setup-return";
import type {
  InstanceTaskId,
  PersonTaskId,
  SetupTask,
} from "@/lib/setup/types";
import { cn } from "@/lib/utils";

/** Where each row of the setup card leads, and its glyph. */
export const PERSON_TASK_ROWS: Record<
  PersonTaskId,
  { href: string; Icon: LucideIcon; sub?: boolean }
> = {
  resume: { href: "/onboarding", Icon: Play },
  medication: { href: `${pageHref("medications")}/new`, Icon: Pill },
  "second-factor": { href: "/settings/security", Icon: Fingerprint },
  "about-you": { href: "/settings/anamnesis", Icon: User, sub: true },
  reading: { href: pageHref("measurements"), Icon: Activity },
  source: { href: "/settings/integrations", Icon: Plug },
  "second-channel": {
    href: "/settings/notifications",
    Icon: MessageCircle,
    sub: true,
  },
  coach: { href: "/settings/ai", Icon: Sparkles },
  "managed-profile": { href: "/settings/access", Icon: UserPlus },
};

/** Where each row of Admin › Setup leads, and its glyph. */
export const INSTANCE_TASK_ROWS: Record<
  InstanceTaskId,
  { href: string; Icon: LucideIcon }
> = {
  "second-factor": { href: "/settings/security", Icon: Fingerprint },
  signups: { href: "/admin/general", Icon: Users },
  relay: { href: "/admin/services", Icon: Bell },
  ai: { href: "/admin/coach", Icon: Sparkles },
  recovery: { href: "/admin/encryption", Icon: KeyRound },
  email: { href: "/admin/services", Icon: Mail },
  sso: { href: "/admin/general", Icon: Shield },
  services: { href: "/admin/integrations", Icon: Cloud },
  backups: { href: "/admin/backups", Icon: ServerCog },
  "error-reporting": { href: "/admin/system-status", Icon: Bug },
};

export const SETUP_CARD_ICON = ListChecks;

/** Settled rows: a "no" counts as settled. */
export function isSettled(task: SetupTask): boolean {
  return task.status === "done" || task.status === "declined";
}

/**
 * One row: the glyph, the name (and one line under it where the row needs
 * one), the value on the right and a chevron. The whole row is the link.
 * Values in foreground; "Not set up" in muted; a deadline under seven days
 * or a detected problem in the warning colour.
 */
export function SetupTaskRow({
  task,
  kind,
  href,
  Icon,
  returnTo,
}: {
  task: SetupTask;
  kind: "person" | "instance";
  href: string;
  Icon: LucideIcon;
  /** Remember this page, so the page the row opens offers a way back. */
  returnTo?: string;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const base = `setup.tasks.${kind}.${task.id}`;
  const sub =
    task.id === "second-factor" && task.deadline
      ? t("setup.tasks.requiredHere")
      : task.id === "recovery" && task.status === "warning"
        ? t("setup.tasks.instance.recoveryKeyAdded")
        : kind === "person" && PERSON_TASK_ROWS[task.id as PersonTaskId]?.sub
          ? t(`${base}Sub`)
          : null;

  let value: string;
  if (task.count) {
    value = t("setup.values.count", task.count);
  } else if (task.deadlineDate && !isSettled(task)) {
    // The server's day in the profile's zone, so the web and the app name
    // the same date wherever the browser is.
    value = t("setup.values.until", {
      date: fmt.dateShortSmartCalendar(task.deadlineDate),
    });
  } else if (task.value) {
    value = t(`setup.values.${task.value}`);
  } else if (task.id === "resume") {
    value = t("setup.values.continue");
  } else {
    value = t(isSettled(task) ? "setup.values.done" : "setup.values.notSetUp");
  }
  const tone =
    task.status === "warning"
      ? "text-warning"
      : isSettled(task) || task.deadline || task.id === "resume"
        ? "text-foreground"
        : "text-muted-foreground";

  return (
    <li data-slot="setup-task" data-task={task.id} data-status={task.status}>
      <Link
        href={href}
        onClick={returnTo ? () => markSetupReturn(returnTo) : undefined}
        className="hover:bg-accent/50 focus-visible:ring-ring/50 flex min-h-14 items-center gap-3 px-4 py-3 focus-visible:ring-[3px] focus-visible:outline-none md:px-6"
      >
        <Icon aria-hidden="true" className="text-foreground size-5 shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{t(base)}</span>
          {sub ? (
            <span className="text-muted-foreground block text-xs">{sub}</span>
          ) : null}
        </span>
        <span className={cn("shrink-0 text-right text-sm", tone)}>{value}</span>
        <ChevronRight
          aria-hidden="true"
          className="text-muted-foreground size-4 shrink-0"
        />
      </Link>
    </li>
  );
}
