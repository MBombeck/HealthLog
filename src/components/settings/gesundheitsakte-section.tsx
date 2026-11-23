"use client";

/**
 * v1.18.0 — Settings → Gesundheitsakte (health record).
 *
 * The full health-record export is a distinct concept — a complete,
 * clinician-ready record (PDF + FHIR R4 + a combined zip package) — and earns
 * its own top-level settings home rather than sharing the page with the
 * generic CSV / JSON data-out paths.
 *
 * The `doctorReport` module governs the data layer, not the Settings
 * entry-point: as of v1.18.6.1 the nav entry always shows (the health record
 * is a flagship export capability and should never silently vanish from
 * Settings). The server-side `/api/export/health-record` route is the hard
 * enforcement — it refuses with a 403 `module.disabled` envelope when the
 * account has opted out, so a disabled doctor-report surface cannot be
 * reached over a Bearer token either.
 *
 * v1.25.7 — the clinician share-link surface (formerly the standalone
 * "Freigabe" section) folds in here as a labelled "Sharing" group below the
 * export panel: a time-boxed read-only link is a sharing face of the SAME
 * health record. `/settings/sharing` 301-redirects to
 * `/settings/health-record#sharing`. The backing model, the
 * `/api/share-links` routes, and the public `/c/[token]` view are unchanged.
 */

import { CalendarSync, Share2 } from "lucide-react";

import { useRecordSurfacePart } from "@/hooks/use-record-surface";
import { useTranslations } from "@/lib/i18n/context";
import { HealthRecordExportPanel } from "@/components/settings/report-selection/selection-panel";
import { SectionHeading } from "@/components/ui/section-heading";
import { SharingSection } from "@/components/settings/sharing-section";
import { CareCalendarFeedCard } from "@/components/settings/care-calendar-feed-card";
import { ReportScheduleCard } from "@/components/settings/report-schedule-card";
import { EmergencyCardEntryCard } from "@/components/settings/emergency-card-entry-card";

export function GesundheitsakteSection() {
  const { t } = useTranslations();
  // Each part follows its own routes' rule (`RECORD_PAGE_SURFACES`): in one's
  // own record all four render; the guardian of a managed profile holds the
  // report, its schedule and the care calendar; an adult's delegate at MANAGE
  // holds the report. The clinician links stay the owner's.
  const doctorReport = useRecordSurfacePart(
    "/settings/health-record",
    "doctorReport",
  );
  const reportSchedule = useRecordSurfacePart(
    "/settings/health-record",
    "reportSchedule",
  );
  const shareLinks = useRecordSurfacePart(
    "/settings/health-record",
    "shareLinks",
  );
  const careCalendar = useRecordSurfacePart(
    "/settings/health-record",
    "careCalendar",
  );
  const emergencyCard = useRecordSurfacePart("/emergency-card", "card");

  // v1.18.6 — the visible page heading + subtitle come from the shared
  // `<SettingsSectionFrame>` in the route; the export panel is the primary
  // surface, with the share-links group sequenced below it.
  return (
    <div className="space-y-10">
      {doctorReport ? <HealthRecordExportPanel /> : null}

      {/* The same report, filed into the documents on its own once a month,
          quarter or year has closed. Uses the selection chosen above. */}
      {reportSchedule ? <ReportScheduleCard /> : null}

      {shareLinks ? (
        <section id="sharing" className="scroll-mt-28 space-y-4">
          <SectionHeading
            // The module tour's "export" stop (the doctor report) anchors here.
            tourId="export-hero"
            icon={Share2}
            title={t("settings.sections.sharing.title")}
            subtitle={t("settings.sections.sharing.subtitle")}
          />
          <SharingSection />
        </section>
      ) : null}

      {/* The emergency card and its QR link: one more way out of the record. */}
      {emergencyCard ? <EmergencyCardEntryCard /> : null}

      {/* Booked visits and care dates coming due, as a calendar the person
          subscribes to: another way the record leaves the app. */}
      {careCalendar ? (
        <section id="calendar" className="scroll-mt-28 space-y-4">
          <SectionHeading
            icon={CalendarSync}
            title={t("careFeed.sectionTitle")}
            subtitle={t("careFeed.sectionSubtitle")}
          />
          <CareCalendarFeedCard />
        </section>
      ) : null}
    </div>
  );
}
