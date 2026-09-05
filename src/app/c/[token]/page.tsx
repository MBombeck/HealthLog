/**
 * v1.11.0 — public clinician view (Epic C, C5).
 *
 * A standalone, read-only RSC at `/c/<token>`. It carries NO app chrome, NO
 * coach / AI / insight generation, and NO session — it is authenticated solely
 * by the unguessable `hls_` token in the path, resolved through the C3
 * {@link resolveShareToken} security core (the only trust boundary here).
 *
 * An unknown / revoked / expired / malformed token resolves to `null` and the
 * page answers a flat `notFound()` (404) — the same blunt response for every
 * failure class so a probe learns nothing.
 *
 * The descriptive wellness scores are fenced inside a muted card carrying the
 * load-bearing "not a clinical assessment / not a diagnosis" disclaimer. KVNR
 * is default OFF (never decrypted or shown here). No markdown anywhere — every
 * string renders as escaped React text children (XSS posture).
 */
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";

import {
  resolveShareGateState,
  resolveShareToken,
} from "@/lib/clinician-share/resolve-share-token";
import { loadShareViewData } from "@/lib/clinician-share/share-view-data";
import {
  unlockCookieName,
  verifyUnlockValue,
} from "@/lib/clinician-share/unlock-cookie";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { resolveShareViewLocale } from "@/lib/clinician-share/request-locale";
import { resolveUserTimezone } from "@/lib/tz/resolver";
import { resolveUserFormatPreferences } from "@/lib/user-format-preferences";
import { ClinicianView } from "@/components/clinician/clinician-view";
import { ShareUnlockGate } from "@/components/clinician/share-unlock-gate";

// Never cache a scoped health view — `no-store` end to end.
export const dynamic = "force-dynamic";
export const revalidate = 0;

// A shared clinical record must never be indexed.
export const metadata: Metadata = {
  title: "Shared health record",
  robots: { index: false, follow: false },
};

export default async function ClinicianSharePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  // v1.18.7 — gate check first, WITHOUT bumping access counters. Resolves a
  // malformed / unknown / revoked / expired token to null → the same flat 404
  // the full read would. A legacy link (no passphrase) falls straight through.
  const gate = await resolveShareGateState(token);
  if (!gate) notFound();

  if (gate.passphraseHash !== null) {
    // Protected link: render nothing of the record until the short-lived,
    // token-scoped unlock cookie is present and valid. Verifying the cookie is
    // constant-time; an invalid / expired / cross-token value shows the gate.
    const cookieStore = await cookies();
    const unlockValue = cookieStore.get(
      unlockCookieName(gate.tokenHash),
    )?.value;
    if (!verifyUnlockValue(unlockValue, gate.tokenHash)) {
      const locale = await resolveShareViewLocale();
      const { t } = getServerTranslator(locale);
      // Resolve the gate copy on the server (it owns the locale) into a plain,
      // serializable object. A `t` function cannot cross the RSC boundary into
      // the client gate — passing one throws at render (issue #374).
      const strings = {
        title: t("clinicianView.unlock.title"),
        description: t("clinicianView.unlock.description"),
        label: t("clinicianView.unlock.label"),
        error: t("clinicianView.unlock.error"),
        submit: t("clinicianView.unlock.submit"),
      };
      return <ShareUnlockGate strings={strings} token={token} />;
    }
  }

  // The ONE trust boundary for the full read. No session is read; this proves
  // only that the raw path token hashes to a live, in-window share link and
  // yields the owner scope. Any failure → null → flat 404. The access counter
  // is bumped here (on a real record render), not on a gate-blocked hit.
  const context = await resolveShareToken(token);
  if (!context) notFound();

  // Issue #490 — period/expiry dates render in the share OWNER's (patient's)
  // profile timezone so they agree with the patient-tz aggregation behind the
  // stats and with the doctor-report PDF (never the container's zone).
  const [
    { report, selection, unavailableLeaves, documents, documentOnly },
    locale,
    ownerTimezone,
    // Issue #922 — the owner's hour cycle and date order, alongside their
    // zone. The PDF at `report.pdf` already read the hour cycle off the
    // owner row; this page read neither, so the same record printed two
    // different spellings depending on which button the practice pressed.
    ownerPrefs,
  ] = await Promise.all([
    loadShareViewData(context),
    resolveShareViewLocale(),
    resolveUserTimezone(context.ownerUserId),
    resolveUserFormatPreferences(context.ownerUserId),
  ]);
  const { t } = getServerTranslator(locale);

  return (
    <ClinicianView
      t={(key, vars) => t(key, vars)}
      label={context.label}
      expiresAt={context.expiresAt.toISOString()}
      report={report}
      selection={selection}
      unavailableLeaves={unavailableLeaves}
      documents={documents}
      documentOnly={documentOnly}
      token={token}
      locale={locale}
      timezone={ownerTimezone}
      timeFormat={ownerPrefs.timeFormat}
      dateFormat={ownerPrefs.dateFormat}
    />
  );
}
