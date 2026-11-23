"use client";

/**
 * The row of links under a feature page's header to the settings that act on
 * that page: the reminders and the care calendar on Check-ups, the calendar on
 * Vaccinations, the report schedule on Documents, the emergency card on the
 * profile.
 *
 * The pattern existed on Check-ups and Labs as hand-written buttons, and every
 * setting that produced something on a page but lived in Settings had to be
 * found by luck. Here each page names its links by surface id, with that
 * surface's address and name written beside it. They are not read from the
 * registry at runtime, which would pull the whole navigation, Settings and
 * Admin model into every page bundle; `surface-registry-guard.test.ts` holds
 * each link to the registry entry of its id, so a link reads exactly like the
 * card it opens and cannot point at an anchor that is gone.
 */
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { useRecordViewer } from "@/hooks/use-record-surface";
import { useTranslations } from "@/lib/i18n/context";
import type { ModuleKey } from "@/lib/modules/registry";
import {
  isRecordSurfacePartPresentable,
  type RecordSurfacePage,
} from "@/lib/sharing/record-page-surfaces";

export interface ContextLink {
  /** A surface id from `SURFACE_REGISTRY`. */
  surface: string;
  /** The surface's `href` and `labelKey`, as the registry has them. */
  href: string;
  labelKey: string;
  /**
   * Inside somebody else's record the link shows only when this part of a
   * page admits the record on screen; without it, only in one's own record.
   */
  record?: { page: RecordSurfacePage; part: string };
  /** Shown only while this module is on. */
  module?: ModuleKey;
}

export const CONTEXT_LINKS = {
  "/care": [
    {
      surface: "settings:notifications#vorsorge-reminders",
      href: "/settings/notifications#vorsorge-reminders",
      labelKey: "notifications.checkupReminders.title",
    },
    {
      surface: "settings:anamnesis#screening-hints",
      href: "/settings/anamnesis#screening-hints",
      labelKey: "records.life.screening.cardTitle",
    },
    {
      surface: "settings:health-record#calendar",
      href: "/settings/health-record#calendar",
      labelKey: "careFeed.title",
      record: { page: "/settings/health-record", part: "careCalendar" },
    },
  ],
  "/vaccinations": [
    {
      surface: "settings:health-record#calendar",
      href: "/settings/health-record#calendar",
      labelKey: "careFeed.title",
      record: { page: "/settings/health-record", part: "careCalendar" },
    },
  ],
  "/documents": [
    {
      surface: "settings:health-record#report-schedule",
      href: "/settings/health-record#report-schedule",
      labelKey: "reportSchedule.title",
      record: { page: "/settings/health-record", part: "reportSchedule" },
      module: "doctorReport",
    },
  ],
  "/profile": [
    {
      surface: "nav:/emergency-card",
      href: "/emergency-card",
      labelKey: "nav.emergencyCard",
      record: { page: "/emergency-card", part: "card" },
    },
  ],
} as const satisfies Record<string, ReadonlyArray<ContextLink>>;

export type ContextLinkPage = keyof typeof CONTEXT_LINKS;

export function ContextLinks({ page }: { page: ContextLinkPage }) {
  const { t } = useTranslations();
  const { user } = useAuth();
  const viewer = useRecordViewer();
  const links = (CONTEXT_LINKS[page] as ReadonlyArray<ContextLink>).filter(
    (link) => {
      if (link.module && user?.modules?.[link.module] === false) return false;
      if (!viewer.inSharedRecord) return true;
      return link.record
        ? isRecordSurfacePartPresentable(
            link.record.page,
            link.record.part as never,
            viewer,
          )
        : false;
    },
  );
  if (links.length === 0) return null;
  return (
    <div
      className="flex flex-wrap gap-2"
      data-slot="context-links"
      data-page={page}
    >
      {links.map((link) => (
        <Button
          key={link.surface}
          asChild
          variant="outline"
          size="sm"
          className="min-h-11 sm:min-h-9"
        >
          <Link href={link.href} data-surface={link.surface}>
            {t(link.labelKey)}
          </Link>
        </Button>
      ))}
    </div>
  );
}
