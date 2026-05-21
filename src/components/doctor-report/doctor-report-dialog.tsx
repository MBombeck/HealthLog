"use client";

/**
 * Doctor-report export dialog (v1.4.15 phase B6 + v1.4.25 W6c).
 *
 * Wraps the trigger button so the user picks:
 *   1. Reporting period (date range, with three presets).
 *   2. Practice / clinic name (optional, persisted between exports).
 *   3. Which data sections appear in the PDF (per-user persisted toggles).
 *
 * Hide-when-empty (Marc 2026-05-14): a section's toggle is only shown
 * when the selected date range actually has data for it — checking a box
 * for an empty section would produce a silently-empty PDF page. The
 * availability probe runs on every range change via
 * `/api/doctor-report/availability`.
 *
 * Privacy default: mood is OFF by default per Marc — mental-health data
 * is opt-in even within a single user's own surface. The API layer
 * filters mood out of the report payload server-side when the toggle is
 * off, so the data never leaves the DB row.
 *
 * Defaults:
 *   - end   = today
 *   - start = today − 90 days
 *   - sections = persisted prefs OR documented defaults
 *
 * Validation runs in the client so the dialog can show inline errors
 * without bouncing through the server. The server still re-validates via
 * `normaliseDateRange()` (silent fallback to last-90-days) — the client
 * messages are UX, not security.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { DateInput } from "@/components/ui/date-input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  DEFAULT_DOCTOR_REPORT_PREFS,
  type DoctorReportPrefs,
} from "@/lib/validations/doctor-report-prefs";
import { useTranslations } from "@/lib/i18n/context";

const ONE_DAY_MS = 86_400_000;
const MAX_RANGE_DAYS = 730;
const PRACTICE_NAME_MAX_LENGTH = 120;

/**
 * Order in which section toggles render. Matches the order the sections
 * appear in the generated PDF so the dialog's mental model lines up with
 * the printed artefact. `mood` is intentionally last because its
 * privacy-sensitive footnote needs prime visual placement.
 */
const SECTION_ORDER: ReadonlyArray<keyof DoctorReportPrefs> = [
  "bp",
  "weight",
  "pulse",
  "bmi",
  "compliance",
  "sleep",
  "mood",
] as const;

interface SectionAvailability {
  bp: boolean;
  weight: boolean;
  pulse: boolean;
  bmi: boolean;
  mood: boolean;
  compliance: boolean;
  sleep: boolean;
}

export interface DoctorReportSubmitPayload {
  startDate: string;
  endDate: string;
  practiceName: string | null;
  /**
   * Per-section toggles. The caller forwards this to
   * `/api/doctor-report` so the aggregator drops disabled sections
   * (mood specifically is filtered at the data layer for privacy).
   */
  sections: DoctorReportPrefs;
}

interface DoctorReportDialogProps {
  /** Controlled open state. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Last-used practice name from `/api/auth/me`; pre-fills the input. */
  defaultPracticeName?: string | null;
  /**
   * Resolves with the user-confirmed payload. The dialog stays open and
   * shows the spinner while the promise is pending; closes on resolve.
   */
  onSubmit: (payload: DoctorReportSubmitPayload) => Promise<void>;
}

/** YYYY-MM-DD in the user's local timezone. */
function todayIso(): string {
  const now = new Date();
  return formatLocalDate(now);
}

function formatLocalDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function defaultStartIso(): string {
  const d = new Date();
  d.setDate(d.getDate() - 90);
  return formatLocalDate(d);
}

function rangeIsoFromLocal(
  startDate: string,
  endDate: string,
): {
  startIso: string;
  endIso: string;
} {
  // Send dates as ISO timestamps anchored to the local day's start/end
  // so an inclusive range `[YYYY-MM-DD, YYYY-MM-DD]` captures everything
  // logged on each boundary day.
  return {
    startIso: new Date(`${startDate}T00:00:00`).toISOString(),
    endIso: new Date(`${endDate}T23:59:59.999`).toISOString(),
  };
}

export function DoctorReportDialog({
  open,
  onOpenChange,
  defaultPracticeName,
  onSubmit,
}: DoctorReportDialogProps) {
  const { t } = useTranslations();
  const [startDate, setStartDate] = useState<string>(defaultStartIso);
  const [endDate, setEndDate] = useState<string>(todayIso);
  const [practiceName, setPracticeName] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Per-user section preferences. Loaded lazily when the dialog opens —
  // skips a roundtrip on every render of the export card.
  const [prefs, setPrefs] = useState<DoctorReportPrefs>(
    DEFAULT_DOCTOR_REPORT_PREFS,
  );
  const [prefsLoaded, setPrefsLoaded] = useState(false);

  // Section availability for the currently-selected range. `null` =
  // "we haven't probed yet" so the section group renders a skeleton row
  // rather than flashing an empty state.
  const [availability, setAvailability] = useState<SectionAvailability | null>(
    null,
  );
  const [availabilityLoading, setAvailabilityLoading] = useState(false);
  const availabilityRequestId = useRef(0);

  // Reset on open: re-anchor dates + practice-name to defaults each time
  // the dialog appears so a follow-up export doesn't reuse the previous
  // custom range. Using the React-recommended "track-the-trigger" pattern
  // (store the last observed `open` state and react during render) so the
  // reset happens in the render phase rather than a setState-in-effect —
  // satisfies the strict `react-hooks/set-state-in-effect` rule.
  const [lastOpen, setLastOpen] = useState(false);
  if (open && !lastOpen) {
    setLastOpen(true);
    setStartDate(defaultStartIso());
    setEndDate(todayIso());
    setPracticeName(defaultPracticeName ?? "");
    setError(null);
    setSubmitting(false);
  } else if (!open && lastOpen) {
    setLastOpen(false);
  }

  // Load persisted section prefs when the dialog opens for the first
  // time. Best-effort: a failure falls back to documented defaults so
  // the dialog stays usable even if the preferences endpoint is down.
  useEffect(() => {
    if (!open || prefsLoaded) return;
    let cancelled = false;
    fetch("/api/auth/me/doctor-report-prefs", { credentials: "include" })
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (cancelled) return;
        const incoming = json?.data;
        if (incoming && typeof incoming === "object") {
          setPrefs({ ...DEFAULT_DOCTOR_REPORT_PREFS, ...incoming });
        }
        setPrefsLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setPrefsLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open, prefsLoaded]);

  // Re-probe availability whenever the range changes. setState calls
  // live inside the promise handlers (microtask-deferred), satisfying
  // the strict `react-hooks/set-state-in-effect` rule while keeping the
  // loading indicator promptly visible. A generation counter prevents
  // a slow earlier response from stomping on a faster later response
  // (classic stale-write race).
  useEffect(() => {
    if (!open) return;
    if (!startDate || !endDate) return;
    const { startIso, endIso } = rangeIsoFromLocal(startDate, endDate);
    const requestId = ++availabilityRequestId.current;
    let cancelled = false;

    Promise.resolve()
      .then(() => {
        if (cancelled) return null;
        setAvailabilityLoading(true);
        return fetch("/api/doctor-report/availability", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ startDate: startIso, endDate: endIso }),
        });
      })
      .then(async (res) => {
        if (cancelled || !res || !res.ok) return;
        const json = (await res.json()) as { data: SectionAvailability };
        if (requestId !== availabilityRequestId.current) return;
        setAvailability(json.data);
      })
      .catch(() => {
        // Best-effort — keep the previous availability snapshot.
      })
      .finally(() => {
        if (!cancelled && requestId === availabilityRequestId.current) {
          setAvailabilityLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [open, startDate, endDate]);

  const validation = useMemo(() => {
    if (!startDate || !endDate) {
      return {
        ok: false as const,
        key: "doctorReport.dialog.errorInvalidDate",
      };
    }
    const start = new Date(startDate);
    const end = new Date(endDate);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return {
        ok: false as const,
        key: "doctorReport.dialog.errorInvalidDate",
      };
    }
    if (end.getTime() < start.getTime()) {
      return {
        ok: false as const,
        key: "doctorReport.dialog.errorEndBeforeStart",
      };
    }
    const spanDays = Math.ceil((end.getTime() - start.getTime()) / ONE_DAY_MS);
    if (spanDays > MAX_RANGE_DAYS) {
      return {
        ok: false as const,
        key: "doctorReport.dialog.errorRangeTooLong",
      };
    }
    return { ok: true as const };
  }, [startDate, endDate]);

  function applyPreset(days: number) {
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - days);
    setStartDate(formatLocalDate(start));
    setEndDate(formatLocalDate(end));
    setError(null);
  }

  // v1.4.43 QoL (M4) — pre-fix this memo built the on-screen toggle
  // list, so sections without data in the current range vanished
  // entirely. The dialog now renders the full `SECTION_ORDER` with
  // strike-through disabled rows for the empties, and the submission
  // payload still force-clears any unavailable toggle so the server
  // never renders an empty section.

  function toggleSection(key: keyof DoctorReportPrefs, value: boolean) {
    setPrefs((current) => ({ ...current, [key]: value }));
  }

  async function persistPrefs(next: DoctorReportPrefs) {
    // Best-effort PUT — a network blip mustn't block PDF generation. The
    // current dialog still submits with the chosen `next` value either
    // way, so the user gets the PDF they asked for even if persistence
    // failed (they'll just see the defaults next time).
    try {
      await fetch("/api/auth/me/doctor-report-prefs", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(next),
      });
    } catch {
      // ignore
    }
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!validation.ok) {
      setError(t(validation.key));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const { startIso, endIso } = rangeIsoFromLocal(startDate, endDate);
      const trimmedPractice = practiceName.trim();

      // Compose the section payload: keep the persisted prefs for keys
      // that ARE available in the range; force `false` for keys that
      // aren't (so the server never tries to render an empty section).
      const sections: DoctorReportPrefs = { ...DEFAULT_DOCTOR_REPORT_PREFS };
      for (const key of SECTION_ORDER) {
        sections[key] = (availability?.[key] ?? false) && prefs[key] === true;
      }

      // Fire-and-forget persistence so the user doesn't wait on it.
      void persistPrefs(prefs);

      await onSubmit({
        startDate: startIso,
        endDate: endIso,
        practiceName:
          trimmedPractice.length > 0
            ? trimmedPractice.slice(0, PRACTICE_NAME_MAX_LENGTH)
            : null,
        sections,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("doctorReport.dialog.title")}</DialogTitle>
          <DialogDescription>
            {t("doctorReport.dialog.description")}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="dr-start">
                {t("doctorReport.dialog.startLabel")}
              </Label>
              <DateInput
                id="dr-start"
                value={startDate}
                max={endDate || todayIso()}
                onChange={(e) => {
                  setStartDate(e.target.value);
                  setError(null);
                }}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="dr-end">
                {t("doctorReport.dialog.endLabel")}
              </Label>
              <DateInput
                id="dr-end"
                value={endDate}
                min={startDate}
                max={todayIso()}
                onChange={(e) => {
                  setEndDate(e.target.value);
                  setError(null);
                }}
                required
              />
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => applyPreset(90)}
            >
              {t("doctorReport.dialog.preset90d")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => applyPreset(180)}
            >
              {t("doctorReport.dialog.preset180d")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => applyPreset(365)}
            >
              {t("doctorReport.dialog.preset365d")}
            </Button>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="dr-practice">
              {t("doctorReport.dialog.practiceLabel")}
            </Label>
            <Input
              id="dr-practice"
              type="text"
              value={practiceName}
              maxLength={PRACTICE_NAME_MAX_LENGTH}
              placeholder={t("doctorReport.dialog.practicePlaceholder")}
              onChange={(e) => setPracticeName(e.target.value)}
              autoComplete="organization"
            />
          </div>

          {/* ── Section toggles ──────────────────────────────────────── */}
          {/*
            v1.4.43 QoL (M4) — pass the full `SECTION_ORDER` (not the
            availability-filtered `activeSections`) so the user sees a
            row for every section that *could* be in the report. Rows
            without data in the current range render disabled with a
            strike-through label + tooltip, so the user understands
            which section is empty and why their PDF has fewer
            sections than expected. The submission payload still
            force-clears any unavailable toggle, so the server never
            renders an empty section.
          */}
          <SectionToggles
            allSections={SECTION_ORDER}
            availability={availability}
            availabilityLoading={availabilityLoading}
            prefs={prefs}
            onToggle={toggleSection}
          />

          {error && (
            <p
              role="alert"
              className="text-destructive text-sm"
              data-testid="doctor-report-dialog-error"
            >
              {error}
            </p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              {t("doctorReport.dialog.cancel")}
            </Button>
            <Button type="submit" disabled={submitting || !validation.ok}>
              {submitting && (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
              )}
              {t("doctorReport.dialog.submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ────────────────────────────── Subviews ──────────────────────────────

/**
 * Exported alongside `SectionToggles` for the SSR component test. The
 * order array is the canonical render order both inside the live
 * dialog and inside the test.
 */
export const __test_SECTION_ORDER = [
  "bp",
  "weight",
  "pulse",
  "bmi",
  "compliance",
  "sleep",
  "mood",
] as const satisfies ReadonlyArray<keyof DoctorReportPrefs>;

interface SectionTogglesProps {
  /**
   * Sections in render order — always the full `SECTION_ORDER` so the
   * dialog shows the user every section that *could* be available, with
   * disabled rows for ones that have no data in the current range.
   */
  allSections: ReadonlyArray<keyof DoctorReportPrefs>;
  availability: SectionAvailability | null;
  availabilityLoading: boolean;
  prefs: DoctorReportPrefs;
  onToggle: (key: keyof DoctorReportPrefs, value: boolean) => void;
}

const SECTION_LABEL_KEYS: Record<keyof DoctorReportPrefs, string> = {
  bp: "doctorReport.sections.bp",
  weight: "doctorReport.sections.weight",
  pulse: "doctorReport.sections.pulse",
  bmi: "doctorReport.sections.bmi",
  mood: "doctorReport.sections.mood",
  compliance: "doctorReport.sections.compliance",
  sleep: "doctorReport.sections.sleep",
};

/**
 * Exported only so the SSR component test in
 * `__tests__/doctor-report-section-toggles.test.tsx` can render the
 * toggle list outside the Radix `Dialog` portal. Treat as internal:
 * the public surface is `<DoctorReportDialog>`.
 */
export function SectionToggles({
  allSections,
  availability,
  availabilityLoading,
  prefs,
  onToggle,
}: SectionTogglesProps) {
  const { t } = useTranslations();

  // First open: show a quiet skeleton row instead of the full toggle
  // list. Keeps the dialog from "flashing" between empty and populated
  // states while the probe is in-flight.
  if (availability === null && availabilityLoading) {
    return (
      <div
        className="border-border bg-muted/30 space-y-2 rounded-lg border p-3"
        data-testid="doctor-report-sections-loading"
      >
        <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
          {t("doctorReport.sections.title")}
        </p>
        <div className="space-y-2">
          <div className="bg-muted h-9 animate-pulse motion-reduce:animate-none rounded-md" />
          <div className="bg-muted h-9 animate-pulse motion-reduce:animate-none rounded-md" />
        </div>
      </div>
    );
  }

  // v1.4.43 QoL (M4) — `availableCount` drives the empty-state hint.
  // Pre-fix, an empty range filtered the list down to zero rows; now
  // we always render every row with the empties disabled, so the
  // empty-state guard kicks in only when *no* section has data.
  const availableCount = availability
    ? allSections.filter((key) => availability[key]).length
    : 0;

  if (availability && availableCount === 0) {
    return (
      <div
        className="border-border bg-muted/30 rounded-lg border p-3"
        data-testid="doctor-report-sections-empty"
      >
        <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
          {t("doctorReport.sections.title")}
        </p>
        <p className="text-muted-foreground mt-1.5 text-xs leading-relaxed">
          {t("doctorReport.sections.empty")}
        </p>
      </div>
    );
  }

  return (
    <div
      className="border-border bg-muted/30 space-y-3 rounded-lg border p-3"
      data-testid="doctor-report-sections"
    >
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
          {t("doctorReport.sections.title")}
        </p>
        {availabilityLoading && (
          <Loader2 className="text-muted-foreground h-3 w-3 animate-spin motion-reduce:animate-none" />
        )}
      </div>
      <ul className="grid grid-cols-1 gap-1 sm:grid-cols-2">
        {allSections.map((key) => {
          const id = `dr-section-${key}`;
          // v1.4.43 QoL (M4) — sections without data in the current
          // range render disabled with a strike-through label and an
          // explanatory tooltip; the user immediately understands
          // why their PDF carries fewer sections than expected.
          const isAvailable = availability?.[key] ?? false;
          const unavailableHint = t("doctorReport.sections.unavailableHint");
          return (
            <li key={key} className="min-h-11">
              <label
                htmlFor={id}
                title={!isAvailable ? unavailableHint : undefined}
                className={`-mx-2 flex items-center justify-between gap-3 rounded-md px-2 py-1.5 transition-colors ${
                  isAvailable
                    ? "hover:bg-muted/50 cursor-pointer"
                    : "cursor-not-allowed opacity-60"
                }`}
                data-unavailable={!isAvailable ? "true" : undefined}
              >
                <span className="flex flex-col">
                  <span
                    className={`text-sm leading-tight font-medium ${
                      isAvailable ? "" : "text-muted-foreground"
                    }`}
                  >
                    {t(SECTION_LABEL_KEYS[key])}
                  </span>
                  {!isAvailable && (
                    <span className="text-muted-foreground text-[11px] leading-tight italic">
                      {unavailableHint}
                    </span>
                  )}
                  {key === "mood" && isAvailable && (
                    <span className="text-muted-foreground text-[11px] leading-tight">
                      {t("doctorReport.sections.moodSensitive")}
                    </span>
                  )}
                </span>
                <Switch
                  id={id}
                  data-testid={`doctor-report-section-${key}`}
                  size="sm"
                  disabled={!isAvailable}
                  checked={isAvailable && prefs[key]}
                  onCheckedChange={(checked) => onToggle(key, checked)}
                />
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
