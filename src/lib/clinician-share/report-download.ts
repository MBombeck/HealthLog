/**
 * The shared gate behind a share link's machine-format downloads.
 *
 * A practice opens the link, unlocks it, and saves the file into their system.
 * That is the thing a bearer-authenticated API was supposed to serve and never
 * did, so this serves it as a download instead: no new credential type, no new
 * scope, no mint path that does not exist.
 *
 * The gate is the document route's, step for step — the same live check, the
 * same token-scoped unlock cookie, a rate limit before any aggregation, the
 * same counter bump, the same blunt 404 for every miss class. It differs in
 * one number: generating a bundle is far more expensive than serving a stored
 * blob, so it gets its own smaller bucket rather than sharing the document
 * route's budget.
 *
 * Scope cannot exceed the page's: both resolve the SAME frozen `sectionsJson`
 * through `selectionFromStoredBlob`, and the insurance leaf is refused at
 * share-link creation, so the insurance number cannot reach this path at all.
 */
import { cookies } from "next/headers";

import { apiError } from "@/lib/api-response";
import { auditLog } from "@/lib/auth/audit";
import { getClientIp } from "@/lib/api-response";
import {
  resolveShareGateState,
  resolveShareToken,
} from "@/lib/clinician-share/resolve-share-token";
import {
  unlockCookieName,
  verifyUnlockValue,
} from "@/lib/clinician-share/unlock-cookie";
import { loadShareViewData } from "@/lib/clinician-share/share-view-data";
import { annotate } from "@/lib/logging/context";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import type { DoctorReportData } from "@/lib/doctor-report-data";
import type { ReportSelection } from "@/lib/report-selection/selection";
import { resolveUserTimezone } from "@/lib/tz/resolver";
import { resolveUserFormatPreferences } from "@/lib/user-format-preferences";
import type {
  DateFormatPreference,
  TimeFormatPreference,
} from "@/lib/format-locale";

/**
 * 20 per hour per link. A practice saves the record once, maybe twice; a
 * leaked token cannot turn the aggregator into a grinder. Deliberately a
 * separate bucket from the document route's 300/h and the unlock route's
 * 10/10min, per the `<surface>:${identifier}` convention.
 */
const REPORT_DOWNLOAD_LIMIT_PER_HOUR = 20;
const REPORT_DOWNLOAD_WINDOW_MS = 60 * 60 * 1000;

/** One blunt 404 for every miss class — a probe distinguishes nothing. */
function notFound() {
  return apiError("Not found", 404, {
    errorCode: "share-link.report.notFound",
  });
}

export type ReportDownloadResult =
  | {
      ok: true;
      report: DoctorReportData;
      selection: ReportSelection;
      /**
       * The OWNER's timezone, clock preference and date order, not the
       * reader's.
       *
       * A reading was recorded at a moment in the owner's life, and the date
       * printed beside it has to be the date it was that day where they were.
       * The page at `c/[token]` already resolves this; the downloads did not,
       * so the same reading could carry one date on screen and another in the
       * PDF a practice files. Resolved here rather than per route so the two
       * download formats cannot drift apart the way the page and the PDF did.
       *
       * Issue #922 — `ownerDateFormat` joined them. The field ORDER is the
       * same class of question as the zone: it belongs to whose record this
       * is, not to whoever opened the link.
       */
      ownerTz: string;
      ownerTimeFormat: TimeFormatPreference;
      ownerDateFormat: DateFormatPreference;
    }
  | { ok: false; response: Response };

/**
 * Run the gate and produce the link's report payload, or the response to
 * return instead. A documents-only link — or one whose frozen scope this build
 * cannot read — has no record to download and gets the same flat 404.
 */
export async function resolveShareReportDownload(
  request: Request,
  token: string,
  format: "fhir" | "pdf",
): Promise<ReportDownloadResult> {
  annotate({ action: { name: "share.report.download" } });

  // 1. Live-gate check first (no counter bump). Malformed / unknown / revoked
  //    / expired all collapse to the same flat 404.
  const gate = await resolveShareGateState(token);
  if (!gate) return { ok: false, response: notFound() };

  // 2. Passphrase gate: a protected link serves nothing until the recipient
  //    holds the short-lived, token-scoped unlock cookie. This route lives
  //    under `/c/<token>` so the browser sends that cookie automatically.
  if (gate.passphraseHash !== null) {
    const cookieStore = await cookies();
    const unlockValue = cookieStore.get(
      unlockCookieName(gate.tokenHash),
    )?.value;
    if (!verifyUnlockValue(unlockValue, gate.tokenHash)) {
      return { ok: false, response: notFound() };
    }
  }

  // 3. Per-link rate limit BEFORE any aggregation.
  const rl = await checkRateLimit(
    `report-download:${gate.tokenHash}`,
    REPORT_DOWNLOAD_LIMIT_PER_HOUR,
    REPORT_DOWNLOAD_WINDOW_MS,
  );
  if (!rl.allowed) {
    const response = apiError("Too many requests. Try again later.", 429, {
      errorCode: "share-link.report.rateLimited",
    });
    for (const [k, v] of Object.entries(rateLimitHeaders(rl))) {
      response.headers.set(k, v);
    }
    return { ok: false, response };
  }

  // 4. Resolve the full share context. Revocation and expiry are re-enforced
  //    here and the access counters are bumped by the same path that bumps
  //    them for the page.
  const context = await resolveShareToken(token);
  if (!context) return { ok: false, response: notFound() };

  // 5. The link's own frozen scope, resolved exactly as the page resolves it,
  //    so the download can never be wider than what the page renders.
  const view = await loadShareViewData(context);
  if (view.documentOnly || !view.report) {
    return { ok: false, response: notFound() };
  }

  await auditLog("share-link.report.download", {
    userId: context.ownerUserId,
    ipAddress: getClientIp(request),
    details: {
      shareLinkId: context.shareLinkId,
      format,
      leafCount: view.selection.leaves.length,
    },
  });
  annotate({
    meta: { format, leafCount: view.selection.leaves.length },
  });

  const [ownerTz, ownerPrefs] = await Promise.all([
    resolveUserTimezone(context.ownerUserId),
    resolveUserFormatPreferences(context.ownerUserId),
  ]);

  return {
    ok: true,
    report: view.report,
    selection: view.selection,
    ownerTz,
    ownerTimeFormat: ownerPrefs.timeFormat,
    ownerDateFormat: ownerPrefs.dateFormat,
  };
}
