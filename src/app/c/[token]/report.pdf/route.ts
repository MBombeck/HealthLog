/**
 * GET /c/{token}/report.pdf — the share link's record as the clinical PDF.
 *
 * Behind the same unlock cookie the page and the document route use, serving
 * exactly the link's frozen selection. Charts are embedded, matching the
 * owner's own default; the practice-name cover line is whatever the owner
 * froze onto the report, which for a share link is nothing.
 *
 * The gate itself lives in `@/lib/clinician-share/report-download` so this
 * route and the bundle beside it cannot drift apart.
 */
import { NextResponse } from "next/server";

import { apiHandler } from "@/lib/api-handler";
import { resolveShareReportDownload } from "@/lib/clinician-share/report-download";
import { renderDoctorReportPdfBytes } from "@/lib/doctor-report-pdf-core";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { resolveShareViewLocale } from "@/lib/clinician-share/request-locale";

type RouteParams = { params: Promise<{ token: string }> };

export const dynamic = "force-dynamic";

export const GET = apiHandler(
  async (request: Request, { params }: RouteParams) => {
    const { token } = await params;
    const resolved = await resolveShareReportDownload(request, token, "pdf");
    if (!resolved.ok) return resolved.response;

    // The recipient's locale, not the owner's: this document is being read by
    // the practice, and the page above it already renders in the same one.
    const locale = await resolveShareViewLocale();
    const { t } = getServerTranslator(locale);
    const bytes = renderDoctorReportPdfBytes(resolved.report, {
      t,
      locale,
      // The locale above is the reader's; these two are the OWNER's, and they
      // have to be. A reading belongs to the day it was that day where the
      // person was, so the date beside it cannot follow whoever opens the
      // link. Without these the renderer fell back to the display default,
      // which meant a practice west of Berlin could file a PDF dated one day
      // off from the page it was downloaded from.
      userTz: resolved.ownerTz,
      timeFormat: resolved.ownerTimeFormat,
      dateFormat: resolved.ownerDateFormat,
      insuranceNumber: null,
      includeCharts: true,
    });
    const stamp = new Date().toISOString().slice(0, 10);
    return new NextResponse(bytes.slice().buffer, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="healthlog-report-${stamp}.pdf"`,
        "Content-Length": String(bytes.byteLength),
        "Cache-Control": "no-store",
      },
    });
  },
);
