"use client";

import { useState } from "react";
import {
  Activity,
  BatteryLow,
  Brain,
  CircleDot,
  Cookie,
  Drama,
  Droplet,
  Droplets,
  Flame,
  Frown,
  Heart,
  HeartPulse,
  Loader2,
  MoonStar,
  PersonStanding,
  Pill,
  Plus,
  Snowflake,
  Soup,
  Stethoscope,
  Tag,
  Thermometer,
  Trash2,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ConfirmButton, ConfirmDialog } from "@/components/ui/confirm-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { SheetSection, SheetSectionCount } from "@/components/ui/sheet-section";
import { useTranslations } from "@/lib/i18n/context";
import { useUnitDisplay } from "@/hooks/use-unit-display";
import { resolveIntlLocale } from "@/lib/format-locale";
import type { Locale } from "@/lib/i18n/config";
import { SymptomIconPicker } from "@/components/symptoms/symptom-icon-picker";
import { FieldInfo } from "./field-info";
import { CYCLE_SYMPTOM_CATALOG } from "./symptom-catalog";
import { FLOW_HUE, PHASE_HUE } from "./phase-tokens";
import type { CalendarDay, CyclePhase, CycleGoal } from "./types";
import {
  useCreateCustomSymptom,
  useCustomSymptoms,
  useCycleDayLog,
  useCycleProfile,
  useDeleteCustomSymptom,
  useDeleteDayLog,
  useEndPeriod,
  useLogDay,
  usePatchDayLog,
  useStartPeriod,
  CustomSymptomError,
  CUSTOM_SYMPTOM_LIMIT_ERROR_CODE,
  type CustomSymptomDTO,
  type CycleDayLogPatch,
} from "./use-cycle";
import type {
  CervicalMucus,
  CervixFirmness,
  CervixOpening,
  CervixPosition,
  ContraceptiveKind,
  CycleDayLogInput,
  CycleSymptomSelection,
  FlowLevel,
  HomeTestResult,
  OvulationTest,
} from "./types";

/**
 * v1.15.0 — the fast-entry log-day sheet.
 *
 * One-tap "started my period today" posts the period-boundary shortcut; the
 * detailed form posts a single day-log (flow, symptoms, BBT, OPK, mucus,
 * intercourse + protection, free-text note). The write is optimistic-ish
 * (the mutation invalidates the cycle keys on success so the calendar +
 * wheel repaint); symptoms list one per line with their intensity beside them.
 *
 * a11y: every chip and symptom toggle is a real `<button>` with `aria-pressed`; the sheet
 * footer sticky-pins Save/Cancel.
 */

const FLOW_LEVELS: FlowLevel[] = ["SPOTTING", "LIGHT", "MEDIUM", "HEAVY"];
const OPK_VALUES: OvulationTest[] = [
  "NEGATIVE",
  "POSITIVE_LH_SURGE",
  "ESTROGEN_SURGE",
  "INDETERMINATE",
];
const MUCUS_VALUES: CervicalMucus[] = [
  "DRY",
  "STICKY",
  "CREAMY",
  "WATERY",
  "EGG_WHITE",
];
const CERVIX_POSITION_VALUES: CervixPosition[] = ["LOW", "HIGH"];
const CERVIX_FIRMNESS_VALUES: CervixFirmness[] = ["FIRM", "SOFT"];
const CERVIX_OPENING_VALUES: CervixOpening[] = ["CLOSED", "OPEN"];
const TEST_RESULTS: HomeTestResult[] = [
  "POSITIVE",
  "NEGATIVE",
  "INDETERMINATE",
];
const CONTRACEPTIVE_KINDS: ContraceptiveKind[] = [
  "ORAL",
  "IUD",
  "IMPLANT",
  "INJECTION",
  "INTRAVAGINAL_RING",
  "PATCH",
  "EMERGENCY",
  "NONE",
];
const SEVERITY_LEVELS = [1, 2, 3, 4] as const;

/**
 * Resolve a custom symptom's stored Lucide icon NAME to its component. Scoped
 * to the `CUSTOM_SYMPTOM_ICON_ALLOWLIST` (server-validated on create) so the
 * import set stays tight; an unknown / null name falls back to `Tag`.
 */
const CUSTOM_ICON_BY_NAME: Record<string, LucideIcon> = {
  Tag,
  Activity,
  Heart,
  HeartPulse,
  Brain,
  Zap,
  Flame,
  Snowflake,
  Droplet,
  CircleDot,
  BatteryLow,
  MoonStar,
  PersonStanding,
  Drama,
  Frown,
  Cookie,
  Soup,
  Pill,
  Thermometer,
  Stethoscope,
};

function customIcon(name: string | null): LucideIcon {
  return (name && CUSTOM_ICON_BY_NAME[name]) || Tag;
}

/** The sheet's editable form state, lifted out so the two save-payload builders
 * are pure + unit-testable (the clear-on-edit semantics are the QA W-2 fix). */
export interface DayLogFormState {
  flow: FlowLevel | null;
  intermenstrual: boolean;
  /** Raw text from the BBT input; "" / non-finite resolves to null. */
  bbt: string;
  /** Whether the BBT reading is marked disturbed (fever/late) — engine skips it. */
  bbtDisturbed: boolean;
  opk: OvulationTest | null;
  mucus: CervicalMucus | null;
  cervixPosition: CervixPosition | null;
  cervixFirmness: CervixFirmness | null;
  cervixOpening: CervixOpening | null;
  intercourse: boolean;
  protectedSex: boolean;
  pregnancyTest: HomeTestResult | null;
  progesteroneTest: HomeTestResult | null;
  contraceptive: ContraceptiveKind | null;
  note: string;
  symptoms: Map<string, number | null>;
}

function resolveBbt(bbt: string): number | null {
  const n = bbt.trim() === "" ? null : Number(bbt);
  return n != null && Number.isFinite(n) ? n : null;
}

/**
 * The temperature field's text, typed in the reader's unit, as the stored
 * degrees Celsius (two decimals, the field's own step). Text equal to what
 * the sheet seeded returns the stored value untouched: converting it there
 * and back would move a reading the person never edited.
 */
export function bbtTextToCelsius(
  text: string,
  seed: { text: string; celsius: number } | null,
  toCelsius: (typed: number) => number,
): number | null {
  const typed = resolveBbt(text);
  if (typed == null) return null;
  if (seed && text === seed.text) return seed.celsius;
  return Math.round(toCelsius(typed) * 100) / 100;
}

function symptomList(
  symptoms: Map<string, number | null>,
): CycleSymptomSelection[] {
  return Array.from(symptoms.entries()).map(([key, severity]) => ({
    key,
    severity,
  }));
}

/**
 * The PATCH payload for an EDIT: every enum carries an explicit `null` when
 * deselected so the server clears it (the POST merge can only add/keep — QA
 * W-2). Pure + exported for the unit test.
 */
export function buildDayLogPatch(
  s: DayLogFormState,
  /**
   * The typed temperature (in the reader's unit) as stored degrees Celsius.
   * The sheet passes the preference-bound conversion; the default reads the
   * field as Celsius.
   */
  bbtToCelsius: (bbt: string) => number | null = resolveBbt,
): CycleDayLogPatch {
  const bbtC = bbtToCelsius(s.bbt);
  return {
    flow: s.flow ?? null,
    intermenstrualBleeding: s.intermenstrual,
    basalBodyTempC: bbtC,
    // Only meaningful with a BBT present; a cleared reading resets the flag.
    temperatureExcluded: bbtC != null ? s.bbtDisturbed : false,
    ovulationTest: s.opk ?? null,
    cervicalMucus: s.mucus ?? null,
    cervixPosition: s.cervixPosition ?? null,
    cervixFirmness: s.cervixFirmness ?? null,
    cervixOpening: s.cervixOpening ?? null,
    sexualActivity: s.intercourse,
    protectedSex: s.intercourse ? s.protectedSex : null,
    pregnancyTest: s.pregnancyTest ?? null,
    progesteroneTest: s.progesteroneTest ?? null,
    contraceptive: s.contraceptive ?? null,
    symptoms: symptomList(s.symptoms),
    note: s.note.trim() ? s.note.trim() : null,
  };
}

/** The POST payload for a NEW row: omit empty enums (a fresh row has nothing to
 * clear); `note` posts an explicit "" so an emptied note never persists. */
export function buildDayLogInput(
  s: DayLogFormState,
  date: string,
  /** See `buildDayLogPatch`. */
  bbtToCelsius: (bbt: string) => number | null = resolveBbt,
): CycleDayLogInput {
  const bbtVal = bbtToCelsius(s.bbt);
  return {
    date,
    loggedAt: new Date().toISOString(),
    source: "MANUAL",
    ...(s.flow ? { flow: s.flow } : {}),
    intermenstrualBleeding: s.intermenstrual,
    ...(bbtVal != null
      ? { basalBodyTempC: bbtVal, temperatureExcluded: s.bbtDisturbed }
      : {}),
    ...(s.opk ? { ovulationTest: s.opk } : {}),
    ...(s.mucus ? { cervicalMucus: s.mucus } : {}),
    ...(s.cervixPosition ? { cervixPosition: s.cervixPosition } : {}),
    ...(s.cervixFirmness ? { cervixFirmness: s.cervixFirmness } : {}),
    ...(s.cervixOpening ? { cervixOpening: s.cervixOpening } : {}),
    sexualActivity: s.intercourse,
    protectedSex: s.intercourse ? s.protectedSex : null,
    ...(s.pregnancyTest ? { pregnancyTest: s.pregnancyTest } : {}),
    ...(s.progesteroneTest ? { progesteroneTest: s.progesteroneTest } : {}),
    ...(s.contraceptive ? { contraceptive: s.contraceptive } : {}),
    symptoms: symptomList(s.symptoms),
    ...(s.note.trim() ? { note: s.note.trim() } : { note: "" }),
  };
}

/**
 * v1.17.0 — section summary-badge counts for the sectioned log-day sheet.
 *
 * Each helper reports how many fields a collapsed section holds, so the
 * badge communicates its contents without expanding it. Pure + exported
 * for the unit tests.
 */
export function symptomsCount(s: DayLogFormState): number {
  return s.symptoms.size;
}

/**
 * Temperature & ovulation: BBT reading, OPK, and the symptothermal secondary
 * sign. Only the sign the section actually renders is counted — mucus when
 * `showCervix` is false, the three cervix observations when true — so the
 * badge never reports a stale value from the surface that isn't shown (e.g.
 * after the user flips the advanced-settings secondary-symptom choice).
 */
export function temperatureCount(
  s: DayLogFormState,
  showCervix: boolean,
): number {
  let n = 0;
  if (resolveBbt(s.bbt) != null) n += 1;
  if (s.opk) n += 1;
  if (showCervix) {
    if (s.cervixPosition) n += 1;
    if (s.cervixFirmness) n += 1;
    if (s.cervixOpening) n += 1;
  } else if (s.mucus) {
    n += 1;
  }
  return n;
}

/** Intimacy & contraception: intercourse logged, and any contraceptive. */
export function intimacyCount(s: DayLogFormState): number {
  let n = 0;
  if (s.intercourse) n += 1;
  if (s.contraceptive) n += 1;
  return n;
}

/** Tests: pregnancy + progesterone home-test results. */
export function testsCount(s: DayLogFormState): number {
  let n = 0;
  if (s.pregnancyTest) n += 1;
  if (s.progesteroneTest) n += 1;
  return n;
}

/** Note: 1 when the free-text note carries content. */
export function noteCount(s: DayLogFormState): number {
  return s.note.trim() ? 1 : 0;
}

/**
 * Whether the form holds nothing a new day-log would record.
 *
 * Saving such a form used to write an empty row: the request succeeded, the
 * sheet closed, and the calendar had nothing to draw, so a person who picked
 * a past date and pressed Save to mark it saw the save "do nothing". A new
 * entry now needs at least one thing to store. An existing row keeps Save
 * enabled, because emptying it is a real edit.
 */
export function isBlankDayLog(s: DayLogFormState): boolean {
  return (
    s.flow === null &&
    !s.intermenstrual &&
    resolveBbt(s.bbt) === null &&
    s.opk === null &&
    s.mucus === null &&
    s.cervixPosition === null &&
    s.cervixFirmness === null &&
    s.cervixOpening === null &&
    !s.intercourse &&
    s.pregnancyTest === null &&
    s.progesteroneTest === null &&
    s.contraceptive === null &&
    s.note.trim() === "" &&
    s.symptoms.size === 0
  );
}

/**
 * What the sheet may do with the form right now.
 *
 * `hydrated` is false between opening a date and its stored row arriving.
 * In that window the form still holds the PREVIOUS date's values and row id,
 * so a quick Save used to PATCH the other date's row and Delete would have
 * removed it. Nothing writes until the form belongs to the date on screen.
 */
export function dayLogSaveState({
  hydrated,
  rowId,
  form,
}: {
  hydrated: boolean;
  rowId: string | null;
  form: DayLogFormState;
}): { rowId: string | null; canSave: boolean; blankNewEntry: boolean } {
  if (!hydrated) return { rowId: null, canSave: false, blankNewEntry: false };
  const blankNewEntry = rowId === null && isBlankDayLog(form);
  return { rowId, canSave: !blankNewEntry, blankNewEntry };
}

/** The sheet's per-date context, read off the calendar grid for that date. */
export interface SheetDayContext {
  startsCycle: boolean;
  periodEndable: boolean;
  phase: CyclePhase | null;
  dayOfCycle: number | null;
}

/**
 * Resolve what the sheet says about `date` from the server's grid day for it.
 * The grid may hold the same date twice where the anchored read and the
 * month read overlap; the later entry wins, as it does in the calendar.
 * A date the grid does not hold gets no claims at all.
 */
export function sheetDayContext(
  date: string,
  days: readonly CalendarDay[],
): SheetDayContext {
  let day: CalendarDay | undefined;
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i].date === date) {
      day = days[i];
      break;
    }
  }
  return {
    startsCycle: day?.isCycleStart ?? false,
    periodEndable: day?.periodEndable ?? false,
    phase: day?.phase ?? null,
    dayOfCycle: day?.cycleDay ?? null,
  };
}

/** The MIN_CYCLES gate the phase-education card uses — mirrored here so the
 * sheet's phase-context header makes the same honesty claim (no phase label
 * until prediction is on, not raw-chart, and at least three cycles seen). */
const MIN_CYCLES_FOR_PHASE = 3;

export interface LogDaySheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The date being logged (YYYY-MM-DD). */
  date: string;
  /** Today (YYYY-MM-DD). */
  today: string;
  /**
   * Whether a logged cycle opens on `date`. Deleting the day-log of a cycle
   * start removes that start too, so the confirm dialog has to say so.
   */
  startsCycle?: boolean;
  /**
   * Whether a one-tap period end can land on `date` (the server's per-date
   * `periodEndable`). It used to follow TODAY's phase, so the button was
   * missing on every back-dated period and appeared on unrelated dates
   * whenever today happened to be a bleeding day.
   */
  periodEndable?: boolean;
  /**
   * The phase of `date` from the calendar read (or null). Drives the
   * hue-tinted phase-context header so the sheet visually belongs to the ring.
   */
  phase?: CyclePhase | null;
  /**
   * The cycle day of `date` for the header ("Day 14 · Ovulatory"); null when
   * the date sits in no logged cycle. Never today's count.
   */
  dayOfCycle?: number | null;
  /**
   * The user's cycle goal — fertility goals (TTC / avoid-pregnancy) auto-open
   * the symptothermal (Temperature & ovulation) section, mirroring Apple's
   * "show the categories that matter to you".
   */
  goal?: CycleGoal;
  /** Honesty-gate inputs for the phase-context header (mirror the education card). */
  predictionEnabled?: boolean;
  rawChartMode?: boolean;
  cyclesObserved?: number;
}

/**
 * v1.18.1 — the hue-tinted phase-context strip atop the sheet, echoing the
 * ring ("Day 14 · Ovulatory" + a phase hue dot). It anchors the capture
 * surface to the wheel + education card so they read as one family. Honesty
 * gate: when the phase label isn't trustworthy (prediction off / raw-chart /
 * fewer than three cycles, or no resolved phase) it shows a neutral header
 * with no phase claim — never a confident phase word the data can't back.
 */
export function PhaseDayHeader({
  phase,
  dayOfCycle,
  predictionEnabled,
  rawChartMode,
  cyclesObserved,
}: {
  phase: CyclePhase | null;
  dayOfCycle: number | null;
  predictionEnabled: boolean;
  rawChartMode: boolean;
  cyclesObserved: number;
}) {
  const { t } = useTranslations();
  const stillLearning =
    !phase ||
    !predictionEnabled ||
    rawChartMode ||
    cyclesObserved < MIN_CYCLES_FOR_PHASE;

  // Nothing trustworthy to anchor to (no phase + no day count) → render no
  // strip at all rather than an empty tile.
  if (stillLearning && dayOfCycle == null) return null;

  const hue = phase ? PHASE_HUE[phase] : PHASE_HUE.LUTEAL;
  const showPhase = !stillLearning && phase != null;

  return (
    <div
      data-slot="cycle-log-phase-header"
      data-phase={showPhase ? phase : "none"}
      style={{ "--tile-hue": hue } as React.CSSProperties}
      className="wellness-tile flex items-center gap-2.5 rounded-xl px-4 py-3"
    >
      {showPhase ? (
        <span
          aria-hidden="true"
          className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: hue }}
        />
      ) : null}
      <p className="text-foreground text-sm font-medium">
        {showPhase && dayOfCycle != null
          ? t("cycle.sheet.phaseDayHeader", {
              day: dayOfCycle,
              phase: t(`cycle.phase.${phase}`),
            })
          : dayOfCycle != null
            ? t("cycle.ring.dayOfCycle", { day: dayOfCycle })
            : t("cycle.phaseEducation.stillLearning")}
      </p>
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "focus-visible:ring-ring/50 inline-flex min-h-11 items-center rounded-full border px-3 py-1.5 text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none sm:min-h-8",
        active
          ? "border-primary bg-primary/10 text-primary"
          : "border-border text-foreground hover:bg-accent",
      )}
    >
      {children}
    </button>
  );
}

/** One labelled row of cervix-sign chips (position / firmness / opening). */
function CervixRow<T extends string>({
  label,
  values,
  current,
  labelFor,
  onToggle,
}: {
  label: string;
  values: readonly T[];
  current: T | null;
  labelFor: (v: T) => string;
  onToggle: (v: T) => void;
}) {
  return (
    <div className="space-y-1.5">
      <p className="text-muted-foreground text-xs font-medium">{label}</p>
      <div className="flex flex-wrap gap-2">
        {values.map((v) => (
          <Chip key={v} active={current === v} onClick={() => onToggle(v)}>
            {labelFor(v)}
          </Chip>
        ))}
      </div>
    </div>
  );
}

/**
 * The day the sheet is writing to, spelled out in the reader's language.
 *
 * The sheet used to be titled "Log your day" whichever cell opened it, so a
 * back-dated entry gave no clue which date it would land on and "Log today"
 * gave no clue that any other date was possible. The weekday is included
 * deliberately: it is how people recognise a date they are recalling.
 */
export function formatSheetDate(date: string, locale: Locale): string {
  // A cycle day key is a calendar day, not an instant, so it is anchored at
  // noon UTC and rendered in UTC — the same anchor the domain's day arithmetic
  // uses. Formatting it in the browser's zone would let a reader east or west
  // of it see the sheet name a different day than the one it writes to.
  return new Date(`${date}T12:00:00Z`).toLocaleDateString(
    resolveIntlLocale(locale),
    {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    },
  );
}

export function LogDaySheet({
  open,
  onOpenChange,
  date,
  today,
  startsCycle = false,
  periodEndable = false,
  phase = null,
  dayOfCycle = null,
  goal,
  predictionEnabled = false,
  rawChartMode = false,
  cyclesObserved = 0,
}: LogDaySheetProps) {
  const { t, locale } = useTranslations();
  const logDay = useLogDay();
  const patchDay = usePatchDayLog();
  const startPeriod = useStartPeriod();
  const endPeriod = useEndPeriod();
  const deleteDay = useDeleteDayLog();
  // Pre-fill from the persisted day-log so a re-log never nulls untouched
  // (or HealthKit-sourced) fields — the v1.15 web data-loss fix.
  const dayLog = useCycleDayLog(open ? date : null);
  // The caller's custom symptoms, merged into the seeded chip grid.
  const customSymptoms = useCustomSymptoms();
  // Drives which symptothermal secondary sign the sheet offers — mucus (default)
  // or the cervix pickers (progressive disclosure: cervix entry only appears
  // when the user chose CERVIX in the advanced cycle settings).
  const cycleProfile = useCycleProfile();
  const showCervix = cycleProfile.data?.secondarySymptom === "CERVIX";

  const [flow, setFlow] = useState<FlowLevel | null>(null);
  const [intermenstrual, setIntermenstrual] = useState(false);
  const [symptoms, setSymptoms] = useState<Map<string, number | null>>(
    new Map(),
  );
  const [bbt, setBbt] = useState<string>("");
  // The temperature field reads and writes in the reader's unit; storage is
  // degrees Celsius. The seeded text keeps its stored value, so saving an
  // untouched reading never drifts it through a round trip of rounding.
  const unitDisplay = useUnitDisplay();
  const [bbtSeed, setBbtSeed] = useState<{
    text: string;
    celsius: number;
  } | null>(null);
  const bbtToCelsius = (text: string): number | null =>
    bbtTextToCelsius(text, bbtSeed, (typed) =>
      unitDisplay.fromDisplay("BODY_TEMPERATURE", typed),
    );
  const [bbtDisturbed, setBbtDisturbed] = useState(false);
  const [opk, setOpk] = useState<OvulationTest | null>(null);
  const [mucus, setMucus] = useState<CervicalMucus | null>(null);
  const [cervixPosition, setCervixPosition] = useState<CervixPosition | null>(
    null,
  );
  const [cervixFirmness, setCervixFirmness] = useState<CervixFirmness | null>(
    null,
  );
  const [cervixOpening, setCervixOpening] = useState<CervixOpening | null>(
    null,
  );
  const [intercourse, setIntercourse] = useState(false);
  const [protectedSex, setProtectedSex] = useState(false);
  const [pregnancyTest, setPregnancyTest] = useState<HomeTestResult | null>(
    null,
  );
  const [progesteroneTest, setProgesteroneTest] =
    useState<HomeTestResult | null>(null);
  const [contraceptive, setContraceptive] = useState<ContraceptiveKind | null>(
    null,
  );
  const [note, setNote] = useState("");
  const [rowId, setRowId] = useState<string | null>(null);
  // Goal-aware disclosure for the symptothermal (Temperature & ovulation)
  // section. Re-evaluated once per (open, date, fetched-row) in the hydration
  // block below: open it when the goal is fertility-oriented (Apple's
  // "show the categories that matter to you") OR when an edited day already
  // holds one of its signs (so a pre-filled value is never hidden — §3.4).
  const [fertilityOpen, setFertilityOpen] = useState(false);

  // Hydrate the form from the fetched DTO once per (open, date, fetched-row)
  // tuple. Tracked as an "adjust state when a prop changes" during render
  // (React's recommended alternative to a setState-in-effect) keyed on the
  // open+date+row-identity, so a re-open or a late-arriving fetch repaints the
  // controls exactly once. `dto === null` (nothing logged) resets to blank.
  const dto = open ? (dayLog.data ?? null) : undefined;
  const formKey = open
    ? `${date}:${dayLog.isSuccess ? "loaded" : "loading"}`
    : null;
  const [lastFormKey, setLastFormKey] = useState<string | null>(null);
  if (open && formKey !== lastFormKey && !dayLog.isLoading) {
    setLastFormKey(formKey);
    setRowId(dto?.id ?? null);
    setFlow((dto?.flow ?? null) as FlowLevel | null);
    setIntermenstrual(dto?.intermenstrualBleeding ?? false);
    setSymptoms(new Map((dto?.symptoms ?? []).map((s) => [s.key, s.severity])));
    const seededBbt =
      dto?.basalBodyTempC != null
        ? String(unitDisplay.toDisplay("BODY_TEMPERATURE", dto.basalBodyTempC))
        : "";
    setBbt(seededBbt);
    setBbtSeed(
      dto?.basalBodyTempC != null
        ? { text: seededBbt, celsius: dto.basalBodyTempC }
        : null,
    );
    setBbtDisturbed(dto?.temperatureExcluded ?? false);
    setOpk((dto?.ovulationTest ?? null) as OvulationTest | null);
    setMucus((dto?.cervicalMucus ?? null) as CervicalMucus | null);
    setCervixPosition((dto?.cervixPosition ?? null) as CervixPosition | null);
    setCervixFirmness((dto?.cervixFirmness ?? null) as CervixFirmness | null);
    setCervixOpening((dto?.cervixOpening ?? null) as CervixOpening | null);
    setIntercourse(dto?.sexualActivity ?? false);
    setProtectedSex(dto?.protectedSex ?? false);
    setPregnancyTest(dto?.pregnancyTest ?? null);
    setProgesteroneTest(dto?.progesteroneTest ?? null);
    setContraceptive(dto?.contraceptive ?? null);
    setNote(dto?.note ?? "");
    // Open the symptothermal section when the goal makes it primary, or when
    // the edited day already carries any of its signs (BBT / OPK / mucus /
    // cervix) — so a pre-filled fertility value is never hidden on edit.
    const fertilityFilled =
      dto?.basalBodyTempC != null ||
      dto?.ovulationTest != null ||
      (showCervix
        ? dto?.cervixPosition != null ||
          dto?.cervixFirmness != null ||
          dto?.cervixOpening != null
        : dto?.cervicalMucus != null);
    setFertilityOpen(
      goal === "TRYING_TO_CONCEIVE" ||
        goal === "AVOID_PREGNANCY" ||
        fertilityFilled,
    );
  } else if (!open && lastFormKey !== null) {
    setLastFormKey(null);
  }
  const hydrated = open && lastFormKey === formKey;

  function toggleSymptom(key: string) {
    setSymptoms((prev) => {
      const next = new Map(prev);
      if (next.has(key)) next.delete(key);
      else next.set(key, null);
      return next;
    });
  }

  function setSymptomSeverity(key: string, severity: number) {
    setSymptoms((prev) => {
      const next = new Map(prev);
      // Tapping the active level clears it back to a plain presence link.
      next.set(key, next.get(key) === severity ? null : severity);
      return next;
    });
  }

  // The live form state, shared by the save-payload builders and the section
  // summary badges (so a collapsed section reports what it holds).
  const formState: DayLogFormState = {
    flow,
    intermenstrual,
    bbt,
    bbtDisturbed,
    opk,
    mucus,
    cervixPosition,
    cervixFirmness,
    cervixOpening,
    intercourse,
    protectedSex,
    pregnancyTest,
    progesteroneTest,
    contraceptive,
    note,
    symptoms,
  };

  const saveState = dayLogSaveState({ hydrated, rowId, form: formState });
  const currentRowId = saveState.rowId;

  async function handleSave() {
    if (!saveState.canSave) return;
    // v1.16.4 — catch so a rejected save doesn't escape as an unhandled
    // rejection; the inline `logDay.isError || patchDay.isError` strip in the
    // footer carries the visible failure signal and the sheet stays open.
    try {
      if (currentRowId) {
        // Editing an existing row → PATCH with explicit nulls so a deselected
        // chip actually CLEARS (the POST merge can only add/keep — QA W-2).
        await patchDay.mutateAsync({
          id: currentRowId,
          patch: buildDayLogPatch(formState, bbtToCelsius),
        });
      } else {
        await logDay.mutateAsync(
          buildDayLogInput(formState, date, bbtToCelsius),
        );
      }
      onOpenChange(false);
    } catch {
      /* surfaced via the inline isError strip */
    }
  }

  // Period boundaries operate on the SELECTED date, so a forgotten day-1 can be
  // corrected from the calendar retroactively (QA M3) — not today-only.
  // v1.16.4 — the rejection is surfaced as a toast by the hook's onError;
  // catching here keeps the sheet open without an unhandled rejection.
  async function handleStartPeriod() {
    try {
      await startPeriod.mutateAsync(date);
      onOpenChange(false);
    } catch {
      /* toast shown by useStartPeriod onError */
    }
  }

  async function handleEndPeriod() {
    try {
      await endPeriod.mutateAsync(date);
      onOpenChange(false);
    } catch {
      /* toast shown by useEndPeriod onError */
    }
  }

  async function handleDelete() {
    if (!currentRowId) return;
    try {
      await deleteDay.mutateAsync(currentRowId);
      onOpenChange(false);
    } catch {
      /* toast shown by useDeleteDayLog onError */
    }
  }

  const busy =
    logDay.isPending ||
    patchDay.isPending ||
    startPeriod.isPending ||
    endPeriod.isPending ||
    deleteDay.isPending;
  const saving = logDay.isPending || patchDay.isPending;

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      // The target date IS the title. Every button below writes to it and
      // nothing else on the surface says which day it is.
      title={
        <span data-slot="cycle-log-sheet-date">
          {t("cycle.sheet.titleForDate", {
            date: formatSheetDate(date, locale),
          })}
        </span>
      }
      description={
        date === today
          ? t("cycle.sheet.descriptionToday")
          : t("cycle.sheet.description")
      }
      contentWidth="lg"
      footer={
        <>
          {currentRowId ? (
            <ConfirmButton
              slot="cycle-day-delete"
              variant="outline"
              className="text-destructive hover:text-destructive mr-auto"
              icon={<Trash2 className="h-4 w-4" />}
              label={t("cycle.sheet.delete")}
              ariaLabel={t("cycle.sheet.delete")}
              title={t("cycle.sheet.deleteTitle")}
              body={
                startsCycle
                  ? t("cycle.sheet.deleteBodyCycleStart")
                  : t("cycle.sheet.deleteBody")
              }
              confirmLabel={t("cycle.sheet.deleteConfirm")}
              disabled={busy && !deleteDay.isPending}
              pending={deleteDay.isPending}
              onConfirm={handleDelete}
            />
          ) : null}
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            {t("cycle.sheet.cancel")}
          </Button>
          <Button
            onClick={handleSave}
            disabled={busy || !saveState.canSave}
            data-slot="cycle-day-save"
          >
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
            ) : null}
            {saving ? t("cycle.sheet.saving") : t("cycle.sheet.save")}
          </Button>
        </>
      }
    >
      {/* Phase-context strip — echoes the ring (day-of-cycle + phase + hue)
          so the capture surface belongs to the wheel. Honesty-gated: no phase
          claim until prediction is trustworthy. */}
      <PhaseDayHeader
        phase={phase}
        dayOfCycle={dayOfCycle}
        predictionEnabled={predictionEnabled}
        rawChartMode={rawChartMode}
        cyclesObserved={cyclesObserved}
      />

      {/* One-tap period boundaries — available on any selected date so a
          forgotten day-1 can be corrected retroactively (M3). "End period"
          shows only where it can land: inside the first days of the logged
          cycle the selected date belongs to. The labels drop the
          word "today" on a back-dated day: they always wrote to the selected
          date, and saying otherwise is how a correction reads as a mistake. */}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          className="flex-1 justify-start gap-2"
          onClick={handleStartPeriod}
          disabled={busy}
          style={{ borderColor: FLOW_HUE }}
        >
          {startPeriod.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
          ) : (
            <Droplets className="h-4 w-4" style={{ color: FLOW_HUE }} />
          )}
          {date === today
            ? t("cycle.startedPeriod")
            : t("cycle.startedPeriodOnDate")}
        </Button>
        {periodEndable ? (
          <Button
            variant="outline"
            className="flex-1 justify-start gap-2"
            onClick={handleEndPeriod}
            disabled={busy}
          >
            {endPeriod.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
            ) : null}
            {date === today
              ? t("cycle.endedPeriod")
              : t("cycle.endedPeriodOnDate")}
          </Button>
        ) : null}
      </div>

      {/* Quick row — Flow is the single most common period sign, so it
          stays always-open at the top alongside the intermenstrual toggle.
          Everything else lives in collapsible sections below. */}
      <Field label={t("cycle.sheet.flow")}>
        <div className="flex flex-wrap gap-2">
          {FLOW_LEVELS.map((f) => (
            <Chip
              key={f}
              active={flow === f}
              onClick={() => setFlow((cur) => (cur === f ? null : f))}
            >
              {t(`cycle.flow.${f}`)}
            </Chip>
          ))}
        </div>
        <div className="mt-2 flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <Label
              htmlFor="cycle-intermenstrual"
              className="text-sm font-normal"
            >
              {t("cycle.sheet.intermenstrualBleeding")}
            </Label>
            <FieldInfo
              label={t("cycle.fieldInfo.spottingLabel")}
              detail={t("cycle.fieldInfo.spotting")}
            />
          </div>
          <Switch
            id="cycle-intermenstrual"
            checked={intermenstrual}
            onCheckedChange={setIntermenstrual}
          />
        </div>
      </Field>

      {/* Symptoms */}
      <SheetSection
        title={t("cycle.sheet.symptoms")}
        summary={<SheetSectionCount count={symptomsCount(formState)} />}
      >
        <div className="space-y-3">
          {CYCLE_SYMPTOM_CATALOG.map((cat) => (
            <div key={cat.key} className="space-y-1.5">
              <div className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium">
                <cat.icon className="h-3.5 w-3.5" aria-hidden="true" />
                {t(cat.labelKey)}
              </div>
              <div className="space-y-1.5">
                {cat.symptoms.map((s) => (
                  <SymptomRow
                    key={s.key}
                    symptomKey={s.key}
                    icon={s.icon}
                    label={t(s.labelKey)}
                    active={symptoms.has(s.key)}
                    severity={symptoms.get(s.key) ?? null}
                    onToggle={toggleSymptom}
                    onSeverity={setSymptomSeverity}
                  />
                ))}
              </div>
            </div>
          ))}

          {/* Custom symptoms — the user's own, under a `custom` category,
              plus the dashed ghost-chip that mints a new one. */}
          <div className="space-y-1.5">
            <div className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium">
              <Tag className="h-3.5 w-3.5" aria-hidden="true" />
              {t("cycle.symptomCategory.custom")}
            </div>
            <div className="space-y-1.5">
              {(customSymptoms.data?.symptoms ?? []).map((s) => (
                <SymptomRow
                  key={s.key}
                  symptomKey={s.key}
                  icon={customIcon(s.icon)}
                  label={s.label ?? t("cycle.symptom.custom.fallbackLabel")}
                  active={symptoms.has(s.key)}
                  severity={symptoms.get(s.key) ?? null}
                  custom={s}
                  onToggle={toggleSymptom}
                  onSeverity={setSymptomSeverity}
                  onClear={(key) => {
                    setSymptoms((prev) => {
                      const next = new Map(prev);
                      next.delete(key);
                      return next;
                    });
                  }}
                />
              ))}
              <AddSymptomChip onCreated={toggleSymptom} />
            </div>
          </div>
        </div>
      </SheetSection>

      {/* Temperature & ovulation — BBT, OPK, and the symptothermal secondary
          sign (mucus or cervix) grouped under one disclosure. Goal-aware
          default: open for fertility goals or when an edited day already
          carries a fertility sign. */}
      <SheetSection
        title={t("cycle.sheet.temperatureSection")}
        open={fertilityOpen}
        onOpenChange={setFertilityOpen}
        summary={
          <SheetSectionCount count={temperatureCount(formState, showCervix)} />
        }
      >
        {/* BBT */}
        <Field
          label={t("cycle.sheet.temperature")}
          info={
            <FieldInfo
              label={t("cycle.fieldInfo.bbtLabel")}
              detail={t("cycle.fieldInfo.bbt")}
            />
          }
        >
          <Input
            type="number"
            inputMode="decimal"
            step="0.01"
            min={unitDisplay.toDisplay("BODY_TEMPERATURE", 30)}
            max={unitDisplay.toDisplay("BODY_TEMPERATURE", 45)}
            value={bbt}
            onChange={(e) => setBbt(e.target.value)}
            placeholder={unitDisplay.unitFor("BODY_TEMPERATURE")}
            className="w-32"
            aria-label={t("cycle.sheet.temperature")}
          />
          <p className="text-muted-foreground text-xs">
            {t("cycle.sheet.bbtHint")}
          </p>
          {resolveBbt(bbt) != null && (
            <div className="mt-3 flex items-start justify-between gap-3">
              <div className="flex flex-col">
                <span className="text-sm">
                  {t("cycle.sheet.temperatureDisturbed")}
                </span>
                <span className="text-muted-foreground text-xs">
                  {t("cycle.sheet.temperatureDisturbedHint")}
                </span>
              </div>
              <Switch
                checked={bbtDisturbed}
                onCheckedChange={setBbtDisturbed}
                aria-label={t("cycle.sheet.temperatureDisturbed")}
              />
            </div>
          )}
        </Field>

        {/* Ovulation test */}
        <Field
          label={t("cycle.sheet.ovulationTest")}
          info={
            <FieldInfo
              label={t("cycle.fieldInfo.ovulationTestLabel")}
              detail={t("cycle.fieldInfo.ovulationTest")}
            />
          }
        >
          <div className="flex flex-wrap gap-2">
            {OPK_VALUES.map((v) => (
              <Chip
                key={v}
                active={opk === v}
                onClick={() => setOpk((cur) => (cur === v ? null : v))}
              >
                {t(`cycle.ovulationTest.${v}`)}
              </Chip>
            ))}
          </div>
        </Field>

        {/* Symptothermal secondary symptom: cervical mucus (default) OR the
          cervix observation, per the user's advanced-settings choice. Only one
          of the two is offered so the log sheet never overwhelms. */}
        {showCervix ? (
          <Field label={t("cycle.sheet.cervix")}>
            <div className="space-y-3">
              <CervixRow
                label={t("cycle.sheet.cervixPosition")}
                values={CERVIX_POSITION_VALUES}
                current={cervixPosition}
                labelFor={(v) => t(`cycle.cervixPosition.${v}`)}
                onToggle={(v) =>
                  setCervixPosition((cur) => (cur === v ? null : v))
                }
              />
              <CervixRow
                label={t("cycle.sheet.cervixFirmness")}
                values={CERVIX_FIRMNESS_VALUES}
                current={cervixFirmness}
                labelFor={(v) => t(`cycle.cervixFirmness.${v}`)}
                onToggle={(v) =>
                  setCervixFirmness((cur) => (cur === v ? null : v))
                }
              />
              <CervixRow
                label={t("cycle.sheet.cervixOpening")}
                values={CERVIX_OPENING_VALUES}
                current={cervixOpening}
                labelFor={(v) => t(`cycle.cervixOpening.${v}`)}
                onToggle={(v) =>
                  setCervixOpening((cur) => (cur === v ? null : v))
                }
              />
            </div>
          </Field>
        ) : (
          <Field
            label={t("cycle.sheet.mucus")}
            info={
              <FieldInfo
                label={t("cycle.fieldInfo.mucusLabel")}
                detail={t("cycle.fieldInfo.mucus")}
              />
            }
          >
            <div className="flex flex-wrap gap-2">
              {MUCUS_VALUES.map((v) => (
                <Chip
                  key={v}
                  active={mucus === v}
                  onClick={() => setMucus((cur) => (cur === v ? null : v))}
                >
                  {t(`cycle.mucus.${v}`)}
                </Chip>
              ))}
            </div>
          </Field>
        )}
      </SheetSection>

      {/* Intimacy & contraception */}
      <SheetSection
        title={t("cycle.sheet.intimacySection")}
        summary={<SheetSectionCount count={intimacyCount(formState)} />}
      >
        {/* Intercourse + protection */}
        <Field label={t("cycle.sheet.intercourse")}>
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5">
                <Label
                  htmlFor="cycle-intercourse"
                  className="text-sm font-normal"
                >
                  {t("cycle.sheet.intercourse")}
                </Label>
                <FieldInfo
                  label={t("cycle.fieldInfo.intercourseLabel")}
                  detail={t("cycle.fieldInfo.intercourse")}
                />
              </div>
              <Switch
                id="cycle-intercourse"
                checked={intercourse}
                onCheckedChange={setIntercourse}
              />
            </div>
            {intercourse ? (
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                  <Label
                    htmlFor="cycle-protected"
                    className="text-muted-foreground text-sm font-normal"
                  >
                    {t("cycle.sheet.protected")}
                  </Label>
                  <FieldInfo
                    label={t("cycle.fieldInfo.protectedLabel")}
                    detail={t("cycle.fieldInfo.protected")}
                  />
                </div>
                <Switch
                  id="cycle-protected"
                  checked={protectedSex}
                  onCheckedChange={setProtectedSex}
                />
              </div>
            ) : null}
          </div>
        </Field>

        {/* Contraceptive */}
        <Field label={t("cycle.sheet.contraceptive")}>
          <div className="flex flex-wrap gap-2">
            {CONTRACEPTIVE_KINDS.map((v) => (
              <Chip
                key={v}
                active={contraceptive === v}
                onClick={() =>
                  setContraceptive((cur) => (cur === v ? null : v))
                }
              >
                {t(`cycle.contraceptive.${v}`)}
              </Chip>
            ))}
          </div>
        </Field>
      </SheetSection>

      {/* Tests */}
      <SheetSection
        title={t("cycle.sheet.testsSection")}
        summary={<SheetSectionCount count={testsCount(formState)} />}
      >
        {/* Pregnancy test */}
        <Field
          label={t("cycle.sheet.pregnancyTest")}
          info={
            <FieldInfo
              label={t("cycle.fieldInfo.pregnancyTestLabel")}
              detail={t("cycle.fieldInfo.pregnancyTest")}
            />
          }
        >
          <div className="flex flex-wrap gap-2">
            {TEST_RESULTS.map((v) => (
              <Chip
                key={v}
                active={pregnancyTest === v}
                onClick={() =>
                  setPregnancyTest((cur) => (cur === v ? null : v))
                }
              >
                {t(`cycle.testResult.${v}`)}
              </Chip>
            ))}
          </div>
        </Field>

        {/* Progesterone test */}
        <Field
          label={t("cycle.sheet.progesteroneTest")}
          info={
            <FieldInfo
              label={t("cycle.fieldInfo.progesteroneTestLabel")}
              detail={t("cycle.fieldInfo.progesteroneTest")}
            />
          }
        >
          <div className="flex flex-wrap gap-2">
            {TEST_RESULTS.map((v) => (
              <Chip
                key={v}
                active={progesteroneTest === v}
                onClick={() =>
                  setProgesteroneTest((cur) => (cur === v ? null : v))
                }
              >
                {t(`cycle.testResult.${v}`)}
              </Chip>
            ))}
          </div>
        </Field>
      </SheetSection>

      {/* Note */}
      <SheetSection
        title={t("cycle.sheet.note")}
        summary={<SheetSectionCount count={noteCount(formState)} />}
      >
        <Textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={500}
          rows={3}
          placeholder={t("cycle.sheet.notePlaceholder")}
          aria-label={t("cycle.sheet.note")}
        />
      </SheetSection>

      {saveState.blankNewEntry ? (
        <p
          className="text-muted-foreground text-xs"
          data-slot="cycle-day-empty-hint"
        >
          {t("cycle.sheet.emptyHint")}
        </p>
      ) : null}

      {logDay.isError || patchDay.isError ? (
        <p className="text-destructive text-sm" role="alert">
          {t("cycle.sheet.saveError")}
        </p>
      ) : null}
    </ResponsiveSheet>
  );
}

function Field({
  label,
  info,
  children,
}: {
  label: string;
  /** Optional inline "?" explainer rendered next to the label (FieldInfo). */
  info?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <p className="text-sm font-medium">{label}</p>
        {info}
      </div>
      {children}
    </div>
  );
}

/**
 * One symptom per line: the toggle on the left, its optional 1-4 intensity
 * on the right (shared by the seeded catalogue and the custom symptoms so both
 * render identically). A custom row additionally carries a remove control that
 * soft-hides the symptom from the catalogue.
 *
 * The intensity used to appear inline next to a chip in a wrapping row, so
 * selecting a symptom widened its chip and pushed every chip after it along,
 * often right out from under the finger reaching for the intensity. The row
 * now reserves the intensity's space whether or not it is shown: selecting a
 * symptom changes colours and reveals the intensity in place, and nothing on
 * the sheet moves.
 */
export function SymptomRow({
  symptomKey,
  icon: Icon,
  label,
  active,
  severity,
  custom,
  onToggle,
  onSeverity,
  onClear,
}: {
  symptomKey: string;
  icon: LucideIcon;
  label: string;
  active: boolean;
  severity: number | null;
  custom?: CustomSymptomDTO;
  onToggle: (key: string) => void;
  onSeverity: (key: string, severity: number) => void;
  onClear?: (key: string) => void;
}) {
  const { t } = useTranslations();
  const deleteCustom = useDeleteCustomSymptom();
  const [confirmRemove, setConfirmRemove] = useState(false);

  async function handleRemove() {
    if (!custom) return;
    onClear?.(custom.key);
    try {
      await deleteCustom.mutateAsync(custom.key);
    } catch {
      /* toast shown by useDeleteCustomSymptom onError */
    }
  }

  return (
    <div
      className="flex items-center gap-2"
      data-slot="cycle-symptom-row"
      data-symptom={symptomKey}
      data-active={active ? "true" : "false"}
    >
      <button
        type="button"
        aria-pressed={active}
        onClick={() => onToggle(symptomKey)}
        className={cn(
          "focus-visible:ring-ring/50 flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-md border px-3 py-1.5 text-left text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none sm:min-h-9",
          active
            ? "border-primary bg-primary/10 text-primary"
            : "border-border text-foreground hover:bg-accent",
        )}
      >
        <Icon className="size-3.5 shrink-0" aria-hidden="true" />
        {/* Wraps rather than truncates: the intensity column leaves a narrow
            label on a phone, and a symptom name cut to "Breast tendern…" is
            not a name. A wrapped row is taller in both states, so it still
            never moves on select. */}
        <span className="min-w-0 leading-snug break-words">{label}</span>
      </button>
      {custom ? (
        <>
          <button
            type="button"
            onClick={() => setConfirmRemove(true)}
            disabled={deleteCustom.isPending}
            aria-label={t("cycle.symptom.custom.remove", { label })}
            className="text-muted-foreground hover:text-foreground hover:bg-accent focus-visible:ring-ring/50 grid size-11 shrink-0 place-items-center rounded-md transition-colors focus-visible:ring-2 focus-visible:outline-none sm:size-9"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
          <ConfirmDialog
            slot="cycle-custom-symptom-remove"
            open={confirmRemove}
            onOpenChange={setConfirmRemove}
            title={t("cycle.symptom.custom.removeTitle")}
            body={t("cycle.symptom.custom.removeBody", { label })}
            confirmLabel={t("cycle.symptom.custom.removeConfirm")}
            pending={deleteCustom.isPending}
            onConfirm={handleRemove}
          />
        </>
      ) : null}
      {/* Always laid out, only shown while the symptom is selected: the
          reserved width is what keeps the row still when it appears. */}
      <div
        className={cn("flex shrink-0 gap-1", !active && "invisible")}
        role="group"
        aria-label={t("cycle.sheet.severity")}
        aria-hidden={active ? undefined : true}
        data-slot="cycle-symptom-severity"
      >
        {SEVERITY_LEVELS.map((lvl) => (
          <button
            key={lvl}
            type="button"
            aria-pressed={severity === lvl}
            aria-label={t("cycle.sheet.severityLevel", { level: lvl })}
            onClick={() => onSeverity(symptomKey, lvl)}
            disabled={!active}
            tabIndex={active ? undefined : -1}
            className={cn(
              "focus-visible:ring-ring/50 grid size-11 place-items-center rounded-full border text-xs tabular-nums transition-colors focus-visible:ring-2 focus-visible:outline-none sm:size-9",
              severity === lvl
                ? "border-primary bg-primary/15 text-primary font-semibold"
                : "border-border text-muted-foreground hover:bg-accent",
            )}
          >
            {lvl}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * The dashed ghost row at the end of the custom symptoms that opens a compact
 * label + icon popover to mint a new custom symptom. Same height and shape as
 * a symptom row so it reads as part of the list, not a foreign button.
 */
export function AddSymptomChip({
  onCreated,
}: {
  onCreated: (key: string) => void;
}) {
  const { t } = useTranslations();
  const create = useCreateCustomSymptom();
  const [openForm, setOpenForm] = useState(false);
  const [label, setLabel] = useState("");
  const [icon, setIcon] = useState<string>("Tag");

  function reset() {
    setLabel("");
    setIcon("Tag");
  }

  async function handleCreate() {
    const trimmed = label.trim();
    if (!trimmed) return;
    try {
      const created = await create.mutateAsync({ label: trimmed, icon });
      // Auto-select the freshly-minted symptom so the user doesn't have to tap
      // the new chip after adding it.
      onCreated(created.key);
      reset();
      setOpenForm(false);
    } catch {
      // Keep the popover open; `create.error` drives the inline message
      // (cap copy on the limit errorCode, generic otherwise).
    }
  }

  // Only the per-user cap surfaces the "limit reached" copy — a transient or
  // validation error must not masquerade as the cap being hit.
  const limitReached =
    create.error instanceof CustomSymptomError &&
    create.error.errorCode === CUSTOM_SYMPTOM_LIMIT_ERROR_CODE;

  return (
    <Popover
      open={openForm}
      onOpenChange={(o) => {
        setOpenForm(o);
        if (!o) reset();
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className="border-border text-muted-foreground hover:border-primary hover:text-primary focus-visible:ring-ring/50 flex min-h-11 w-full items-center gap-2 rounded-md border border-dashed px-3 py-1.5 text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none sm:min-h-9"
        >
          <Plus className="size-3.5" aria-hidden="true" />
          {t("cycle.symptom.custom.add")}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="custom-symptom-label" className="text-xs font-medium">
            {t("cycle.symptom.custom.label")}
          </Label>
          <Input
            id="custom-symptom-label"
            value={label}
            maxLength={40}
            autoFocus
            placeholder={t("cycle.symptom.custom.labelPlaceholder")}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void handleCreate();
              }
            }}
          />
        </div>
        <div className="space-y-1.5">
          <p className="text-xs font-medium">
            {t("cycle.symptom.custom.icon")}
          </p>
          <SymptomIconPicker
            value={icon}
            onChange={setIcon}
            label={t("cycle.symptom.custom.icon")}
          />
        </div>
        {limitReached ? (
          <p className="text-destructive text-sm" role="alert">
            {t("cycle.symptom.custom.limitReached")}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              reset();
              setOpenForm(false);
            }}
          >
            {t("cycle.sheet.cancel")}
          </Button>
          <Button
            size="sm"
            onClick={handleCreate}
            disabled={!label.trim() || create.isPending}
          >
            {create.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
            ) : null}
            {t("cycle.symptom.custom.add")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
