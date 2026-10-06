/**
 * Clarifying questions. The model may end a reply with a `---CLARIFY---`
 * block when the metric or window stays genuinely ambiguous:
 *
 *   Which pulse do you mean?
 *   ---CLARIFY---
 *   kind: metric
 *   choices: pulse, resting_hr, walking_hr
 *   ---END---
 *
 * The block is always stripped from the prose. What survives is decided here,
 * never by the model:
 *
 * - `metric` choices are kept only when the record holds that metric (an
 *   inventory row marked present). Fewer than two left, and there is nothing
 *   to choose between: the clarification is dropped and the reply stands.
 * - `window` choices come from the window presets only.
 * - `context` carries no choices; the person types the answer.
 * - The question text is the reply itself. It is screened like any reply
 *   (the outbound screen and the refusal detector); a hit drops the choices.
 *
 * Labels are rendered on the server from the catalog, so no model text ever
 * reaches a button. The person answers with
 * `clarification: { messageId, choiceId? }`, which `resolveClarificationAnswer`
 * turns into one server-written line for the next turn's context.
 */
import {
  readLatestMessages,
  type LatestMessage,
  type LatestMessagesLoader,
} from "@/lib/ai/coach/latest-messages";
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import type { Locale } from "@/lib/i18n/config";
import { resolveIntlLocale } from "@/lib/format-locale";
import { isModuleEnabled } from "@/lib/modules/gate";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import {
  coachScopeSourceSchema,
  coachScopeWindowSchema,
  type CoachAssumption,
  type CoachClarification,
  type CoachClarificationChoice,
  type CoachClarificationKind,
  type CoachComparisonBasis,
  type CoachScopeSource,
  type CoachScopeWindow,
} from "@/lib/ai/coach/types";
import { coachClarificationSchema } from "@/lib/ai/coach/stream-events";
import {
  COACH_FOLLOW_UP_KEYS,
  clarifyWindowLabelKey,
  coachDomainLabelKey,
} from "@/lib/ai/coach/dialog-keys";
import { screenCoachReply } from "@/lib/ai/coach/outbound-guard";
import { detectRefusal } from "@/lib/ai/coach/refusal";
import { COACH_SOURCE_DOMAIN_LABEL } from "@/lib/ai/coach/tools/source-keys";
import type { InventoryEntry } from "@/lib/ai/coach/tools/inventory";

const OPEN_SENTINEL = "---CLARIFY---";
const CLOSE_SENTINEL = "---END---";
/** Block body cap in bytes, after the opening marker. */
export const CLARIFY_BYTE_CAP = 512;
/** At most this many choices on a card. */
export const CLARIFY_MAX_CHOICES = 4;
/**
 * A clarifying question is one short sentence. A reply longer than this
 * answered something as well, so it is not a question and gets no card.
 */
const QUESTION_CHAR_CAP = 400;

type ClarifyKind = CoachClarification["kind"];

/** Why a block did not become a card. Ops-facing only. */
export type ClarifyDropReason =
  | "malformed"
  | "byte_overflow"
  | "too_few_metrics"
  | "no_window_choices"
  | "no_question"
  | "question_too_long"
  | "screened"
  | "no_inventory";

/**
 * Dedicated-tool rows of the inventory carry no `metric` argument; these are
 * the scope sources they stand for.
 */
const DEDICATED_TOOL_SOURCE: Readonly<Record<string, CoachScopeSource>> = {
  get_sleep: "sleep",
  get_glucose_panel: "glucose",
  get_medication_compliance: "compliance",
};

const SCOPE_SOURCES: ReadonlySet<string> = new Set(
  coachScopeSourceSchema.options,
);
/** Lower-cased preset → the preset, so "lastyear" still maps to "lastYear". */
const WINDOW_BY_TOKEN: ReadonlyMap<string, CoachScopeWindow> = new Map(
  coachScopeWindowSchema.options.map((w) => [w.toLowerCase(), w]),
);

/** "resting heart rate" → "resting_hr", so either spelling maps. */
const SOURCE_BY_DOMAIN_LABEL: ReadonlyMap<string, CoachScopeSource> = new Map(
  (
    Object.entries(COACH_SOURCE_DOMAIN_LABEL) as Array<
      [CoachScopeSource, string]
    >
  ).map(([source, label]) => [label.toLowerCase(), source]),
);

function normaliseToken(raw: string): string {
  return raw
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim()
    .toLowerCase();
}

function toSource(token: string): CoachScopeSource | null {
  const t = normaliseToken(token);
  if (SCOPE_SOURCES.has(t)) return t as CoachScopeSource;
  return SOURCE_BY_DOMAIN_LABEL.get(t) ?? null;
}

/** The scope sources the record holds, from the inventory's present rows. */
export function presentSources(
  inventory: readonly InventoryEntry[],
): Set<CoachScopeSource> {
  const out = new Set<CoachScopeSource>();
  for (const entry of inventory) {
    if (!entry.present) continue;
    if (entry.metric && SCOPE_SOURCES.has(entry.metric)) {
      out.add(entry.metric as CoachScopeSource);
      continue;
    }
    const dedicated = DEDICATED_TOOL_SOURCE[entry.tool];
    if (dedicated) out.add(dedicated);
  }
  return out;
}

interface RawBlock {
  kind: string | null;
  choices: string[];
}

/**
 * Cut the block out of the prose. Returns the prose without it and the raw
 * block, or a drop reason when a block was there but unusable. A reply with
 * no marker comes back untouched with `block: null` and no reason.
 */
function extractBlock(prose: string): {
  prose: string;
  block: RawBlock | null;
  dropped: ClarifyDropReason | null;
} {
  const open = prose.indexOf(OPEN_SENTINEL);
  if (open === -1) return { prose, block: null, dropped: null };
  const before = prose.slice(0, open);
  const afterOpen = prose.slice(open + OPEN_SENTINEL.length);
  const close = afterOpen.indexOf(CLOSE_SENTINEL);
  if (close === -1) {
    // No closing marker: everything after the opening one is the block.
    // Never show the raw marker; drop the whole tail.
    return { prose: before.trimEnd(), block: null, dropped: "malformed" };
  }
  const body = afterOpen.slice(0, close);
  const after = afterOpen.slice(close + CLOSE_SENTINEL.length);
  const stripped = `${before.trimEnd()}${after.trim() ? `\n\n${after.trim()}` : ""}`;
  if (Buffer.byteLength(body, "utf8") > CLARIFY_BYTE_CAP) {
    return { prose: stripped, block: null, dropped: "byte_overflow" };
  }
  let kind: string | null = null;
  let choices: string[] = [];
  for (const line of body.split("\n")) {
    const colon = line.indexOf(":");
    if (colon < 1) continue;
    const key = normaliseToken(line.slice(0, colon));
    const value = line.slice(colon + 1);
    if (key === "kind") kind = normaliseToken(value);
    else if (key === "choices") {
      choices = value
        .split(/[,|;]/)
        .map((c) => c.trim())
        .filter((c) => c.length > 0);
    }
  }
  return { prose: stripped, block: { kind, choices }, dropped: null };
}

function isKind(value: string | null): value is ClarifyKind {
  return (
    value === "metric" ||
    value === "window" ||
    value === "comparison" ||
    value === "goal" ||
    value === "anchor" ||
    value === "context"
  );
}

function metricChoices(
  tokens: readonly string[],
  present: ReadonlySet<CoachScopeSource>,
  locale: Locale,
): CoachClarificationChoice[] {
  const { t } = getServerTranslator(locale);
  const seen = new Set<CoachScopeSource>();
  const choices: CoachClarificationChoice[] = [];
  for (const token of tokens) {
    const source = toSource(token);
    if (!source || seen.has(source) || !present.has(source)) continue;
    seen.add(source);
    const labelKey = coachDomainLabelKey(source);
    choices.push({
      id: `c${choices.length + 1}`,
      labelKey,
      label: t(labelKey),
      value: { metric: source },
    });
    if (choices.length === CLARIFY_MAX_CHOICES) break;
  }
  return choices;
}

function windowChoices(
  tokens: readonly string[],
  locale: Locale,
): CoachClarificationChoice[] {
  const { t } = getServerTranslator(locale);
  const seen = new Set<CoachScopeWindow>();
  const choices: CoachClarificationChoice[] = [];
  for (const token of tokens) {
    const window = WINDOW_BY_TOKEN.get(normaliseToken(token));
    if (!window || seen.has(window)) continue;
    seen.add(window);
    const labelKey = clarifyWindowLabelKey(window);
    choices.push({
      id: `c${choices.length + 1}`,
      labelKey,
      label: t(labelKey),
      value: { window },
    });
    if (choices.length === CLARIFY_MAX_CHOICES) break;
  }
  return choices;
}

function hasQuestionMark(text: string): boolean {
  return /[?？]/.test(text);
}

export function parseClarifySentinel(args: {
  prose: string;
  /** What the record holds; null on the no-tools path. */
  inventory: InventoryEntry[] | null;
  locale: Locale;
}): { prose: string; clarification: CoachClarification | null } {
  const { locale, inventory } = args;
  const extracted = extractBlock(args.prose);
  const prose = extracted.prose;
  const drop = (reason: ClarifyDropReason, kind?: string | null) => {
    annotate({
      action: { name: "coach.clarification.dropped" },
      meta: { reason, kind: isKind(kind ?? null) ? kind : "unknown" },
    });
    return { prose, clarification: null };
  };
  if (extracted.dropped) return drop(extracted.dropped);
  const block = extracted.block;
  if (!block) return { prose, clarification: null };
  if (!isKind(block.kind)) return drop("malformed", block.kind);
  const kind = block.kind;

  const question = prose.trim();
  if (!question || !hasQuestionMark(question)) return drop("no_question", kind);
  if (question.length > QUESTION_CHAR_CAP) {
    return drop("question_too_long", kind);
  }
  // The question is model text shown to the person: screen it like a reply,
  // and like a message (an instruction smuggled into a question is refused).
  if (
    screenCoachReply(question, locale).block ||
    detectRefusal({ message: question, locale }).refuse
  ) {
    return drop("screened", kind);
  }

  let choices: CoachClarificationChoice[] = [];
  if (kind === "metric") {
    // Without an inventory nothing proves the record holds a metric, so
    // there is nothing to offer.
    if (!inventory) return drop("no_inventory", kind);
    choices = metricChoices(block.choices, presentSources(inventory), locale);
    if (choices.length < 2) return drop("too_few_metrics", kind);
  } else if (kind === "window") {
    choices = windowChoices(block.choices, locale);
    if (choices.length < 2) return drop("no_window_choices", kind);
  }

  annotate({
    action: { name: "coach.clarification.offered" },
    meta: { kind, choices: choices.length },
  });
  return {
    prose,
    clarification: { kind, choices, freeText: true },
  };
}

function storedClarification(
  metricSourceJson: string | null,
): CoachClarification | null {
  if (!metricSourceJson) return null;
  try {
    const raw = (JSON.parse(metricSourceJson) as { clarification?: unknown })
      .clarification;
    if (raw === undefined) return null;
    const parsed = coachClarificationSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Never two questions in a row: when the previous assistant reply already
 * asked one, a new block is dropped and the reply stands as an answer. Runs
 * after the person's message is persisted, so the latest assistant row is
 * the previous reply. Reads nothing when there is no clarification to check.
 */
export async function dropRepeatClarification(args: {
  userId: string;
  conversationId: string;
  clarification: CoachClarification | null;
  /** The turn's shared read of the latest messages, when it has one. */
  latest?: LatestMessagesLoader;
}): Promise<CoachClarification | null> {
  const { clarification } = args;
  if (!clarification) return null;
  try {
    const rows = await (args.latest?.() ??
      readLatestMessages(args.userId, args.conversationId));
    const previous = rows.find(
      (m) => m.role === "assistant" && m.providerType !== "cancelled",
    );
    if (previous && storedClarification(previous.metricSourceJson)) {
      annotate({
        action: { name: "coach.clarification.dropped" },
        meta: { reason: "repeat", kind: clarification.kind },
      });
      return null;
    }
    return clarification;
  } catch {
    // Unverifiable: offering no card is the safe side.
    return null;
  }
}

function clarifiedLine(choice: CoachClarificationChoice): string {
  const parts: string[] = [];
  if (choice.value.metric) parts.push(`metric=${choice.value.metric}`);
  if (choice.value.window) parts.push(`window=${choice.value.window}`);
  if (choice.value.comparison) {
    parts.push(`comparison=${choice.value.comparison}`);
  }
  // A goal or an anchor is an id the model never saw; the server-rendered
  // label says what it stands for.
  if (choice.value.goal || choice.value.anchor) {
    parts.push(`"${choice.label}"`);
  }
  return `CLARIFIED: the person answered your clarifying question by choosing ${parts.join(" ")}. Answer the original question with exactly this; do not ask again.`;
}

const FREE_TEXT_LINE =
  "CLARIFIED: the person answered your clarifying question in their own words (their latest message). Take it as the answer to the original question; do not ask again.";

/**
 * The turn-context line for an answered clarification, or null when the
 * request carries none or its question is no longer current.
 *
 * The question must be the conversation's latest message, asked by the
 * assistant, with its choices on file. The choice value is read from what
 * the server stored, never from the request.
 */
export async function resolveClarificationAnswer(args: {
  userId: string;
  conversationId: string | undefined;
  clarification: { messageId: string; choiceId?: string } | undefined;
  /** The turn's shared read of the latest messages, when it has one. */
  latest?: LatestMessagesLoader;
}): Promise<string | null> {
  const { userId, conversationId, clarification } = args;
  if (!clarification || !conversationId) return null;
  let rows: LatestMessage[];
  try {
    rows = await (args.latest?.() ??
      readLatestMessages(userId, conversationId));
  } catch {
    return null;
  }
  const latest = rows.find((m) => m.providerType !== "cancelled");
  const stored =
    latest &&
    latest.id === clarification.messageId &&
    latest.role === "assistant"
      ? storedClarification(latest.metricSourceJson)
      : null;
  if (!stored) {
    annotate({
      action: { name: "coach.clarification.stale" },
      meta: { conversationId },
    });
    return null;
  }
  const choice = clarification.choiceId
    ? stored.choices.find((c) => c.id === clarification.choiceId)
    : undefined;
  annotate({
    action: { name: "coach.clarification.answered" },
    meta: { kind: stored.kind, via: choice ? "choice" : "text" },
  });
  return choice ? clarifiedLine(choice) : FREE_TEXT_LINE;
}

// ── The ask_clarification tool (v1.41) ──────────────────────────────────

/** A clarifying question asked through the tool, at most this long. */
export const CLARIFY_TOOL_QUESTION_MAX = 200;

/** At most one question in this many turns of a conversation. */
export const CLARIFY_TURN_SPACING = 6;
/** At most this many questions a day, across every conversation. */
export const CLARIFY_DAILY_LIMIT = 3;

/** The catalog of comparison bases, each with its reply label. */
const COMPARISON_LABEL_KEY: Readonly<Record<CoachComparisonBasis, string>> = {
  previous_period: COACH_FOLLOW_UP_KEYS.previous_period,
  year_ago: COACH_FOLLOW_UP_KEYS.year_ago,
  // Pending until integration copies it into the bundles.
  baseline_90d: "coach.clarify.comparison.baseline90d",
};

/** A pending key: "Since {date}", an illness episode as an anchor. */
const ANCHOR_ILLNESS_KEY = "coach.clarify.anchor.illness";

/** A choice the server built from the record: an id and a catalog label. */
export interface ClarifyRecordChoice {
  id: string;
  labelKey: string;
  label: string;
}

/** What the model passed to `ask_clarification`, after its schema. */
export interface ClarifyToolCall {
  kind: CoachClarificationKind;
  question: string;
  choices?: string[];
  assumption?: string;
}

export type ClarifyToolOutcome =
  | { ok: true; question: string; clarification: CoachClarification }
  | { ok: false; reason: ClarifyDropReason | "no_record_choices" };

function comparisonChoices(
  tokens: readonly string[],
  locale: Locale,
): CoachClarificationChoice[] {
  const { t } = getServerTranslator(locale);
  const seen = new Set<CoachComparisonBasis>();
  const choices: CoachClarificationChoice[] = [];
  for (const token of tokens) {
    const basis = normaliseToken(token) as CoachComparisonBasis;
    if (!Object.hasOwn(COMPARISON_LABEL_KEY, basis) || seen.has(basis)) {
      continue;
    }
    seen.add(basis);
    const labelKey = COMPARISON_LABEL_KEY[basis];
    choices.push({
      id: `c${choices.length + 1}`,
      labelKey,
      label: t(labelKey),
      value: { comparison: basis },
    });
    if (choices.length === CLARIFY_MAX_CHOICES) break;
  }
  return choices;
}

function recordChoices(
  candidates: readonly ClarifyRecordChoice[],
  field: "goal" | "anchor",
): CoachClarificationChoice[] {
  return candidates.slice(0, CLARIFY_MAX_CHOICES).map((candidate, index) => ({
    id: `c${index + 1}`,
    labelKey: candidate.labelKey,
    label: candidate.label,
    value: { [field]: candidate.id },
  }));
}

/** The assumed choice first, ids renumbered `c1`... */
function assumedFirst(
  choices: CoachClarificationChoice[],
  assumption: string | undefined,
): CoachClarificationChoice[] {
  if (choices.length === 0) return choices;
  const token = assumption ? normaliseToken(assumption) : null;
  const matches = (choice: CoachClarificationChoice): boolean => {
    if (!token) return false;
    const v = choice.value;
    return (
      v.metric === toSource(token) ||
      v.window === WINDOW_BY_TOKEN.get(token) ||
      v.comparison === token ||
      v.goal === assumption ||
      v.anchor === assumption
    );
  };
  const index = Math.max(0, choices.findIndex(matches));
  const ordered = [choices[index], ...choices.filter((_, i) => i !== index)];
  return ordered.map((choice, i) => ({ ...choice, id: `c${i + 1}` }));
}

/**
 * Validate an `ask_clarification` call into the question and its choices.
 * The same rules as the sentinel: catalog labels only, metrics the record
 * holds, a screened question that is a question. `goal` and `anchor`
 * choices are never the model's: the server lists them from the record, and
 * without two of them there is nothing to ask.
 */
export function buildClarificationFromTool(args: {
  call: ClarifyToolCall;
  inventory: InventoryEntry[] | null;
  locale: Locale;
  goals?: readonly ClarifyRecordChoice[];
  anchors?: readonly ClarifyRecordChoice[];
}): ClarifyToolOutcome {
  const { call, locale } = args;
  const kind = call.kind;
  const drop = (reason: ClarifyDropReason | "no_record_choices") => {
    annotate({
      action: { name: "coach.clarification.dropped" },
      meta: { reason, kind, via: "tool" },
    });
    return { ok: false as const, reason };
  };
  const question = call.question.replace(/\s+/g, " ").trim();
  if (!question || !hasQuestionMark(question)) return drop("no_question");
  if (question.length > CLARIFY_TOOL_QUESTION_MAX) {
    return drop("question_too_long");
  }
  if (
    screenCoachReply(question, locale).block ||
    detectRefusal({ message: question, locale }).refuse
  ) {
    return drop("screened");
  }
  const tokens = call.choices ?? [];
  let choices: CoachClarificationChoice[] = [];
  switch (kind) {
    case "metric":
      if (!args.inventory) return drop("no_inventory");
      choices = metricChoices(
        tokens,
        presentSources(args.inventory),
        locale,
      );
      if (choices.length < 2) return drop("too_few_metrics");
      break;
    case "window":
      choices = windowChoices(tokens, locale);
      if (choices.length < 2) return drop("no_window_choices");
      break;
    case "comparison":
      choices = comparisonChoices(tokens, locale);
      if (choices.length < 2) return drop("malformed");
      break;
    case "goal":
      choices = recordChoices(args.goals ?? [], "goal");
      if (choices.length < 2) return drop("no_record_choices");
      break;
    case "anchor":
      choices = recordChoices(args.anchors ?? [], "anchor");
      if (choices.length < 2) return drop("no_record_choices");
      break;
    case "context":
      break;
  }
  choices = assumedFirst(choices, call.assumption);
  annotate({
    action: { name: "coach.clarification.offered" },
    meta: { kind, choices: choices.length, via: "tool" },
  });
  return {
    ok: true,
    question,
    clarification: {
      kind,
      choices,
      freeText: true,
      ...(choices.length > 0 ? { assumption: "c1" } : {}),
    },
  };
}

/**
 * The assumption a question stands for when it is not asked (declined by
 * the brake): its assumed choice, with the others as alternatives. Only the
 * kinds the answer can carry an assumption line for.
 */
export function assumptionFromClarification(
  clarification: CoachClarification,
): CoachAssumption | null {
  if (
    clarification.kind !== "metric" &&
    clarification.kind !== "window" &&
    clarification.kind !== "comparison"
  ) {
    return null;
  }
  const [assumed, ...rest] = clarification.choices;
  if (!assumed) return null;
  const option = (choice: CoachClarificationChoice) => ({
    labelKey: choice.labelKey,
    label: choice.label,
    value: choice.value,
  });
  return {
    kind: clarification.kind,
    value: option(assumed),
    alternatives: rest.slice(0, 3).map(option),
  };
}

/** `BLOOD_PRESSURE` → `bp`, `WEIGHT` → `weight`; null when there is no match. */
function planMetricSource(metric: string): CoachScopeSource | null {
  const token = metric.trim().toLowerCase();
  if (token === "blood_pressure") return "bp";
  return SCOPE_SOURCES.has(token) ? (token as CoachScopeSource) : null;
}

/**
 * The choices a `goal` or `anchor` question may offer, from the record:
 * the person's active plans by the metric each moves, and the illness
 * episodes that began most recently. Labels are catalog text and a date;
 * no plan or episode text reaches them.
 */
export async function loadClarifyRecordChoices(args: {
  userId: string;
  kind: "goal" | "anchor";
  locale: Locale;
}): Promise<ClarifyRecordChoice[]> {
  const { t } = getServerTranslator(args.locale);
  try {
    if (args.kind === "goal") {
      const plans = await prisma.coachPlan.findMany({
        where: { userId: args.userId, status: "active", deletedAt: null },
        orderBy: { updatedAt: "desc" },
        take: 8,
        select: { id: true, metric: true },
      });
      const seen = new Set<CoachScopeSource>();
      const out: ClarifyRecordChoice[] = [];
      for (const plan of plans) {
        const source = planMetricSource(plan.metric);
        if (!source || seen.has(source)) continue;
        seen.add(source);
        const labelKey = coachDomainLabelKey(source);
        out.push({ id: plan.id, labelKey, label: t(labelKey) });
      }
      return out.slice(0, CLARIFY_MAX_CHOICES);
    }
    if (!(await isModuleEnabled(args.userId, "illness"))) return [];
    const episodes = await prisma.illnessEpisode.findMany({
      where: { userId: args.userId, deletedAt: null },
      orderBy: { onsetAt: "desc" },
      take: 3,
      select: { id: true, onsetAt: true },
    });
    const format = new Intl.DateTimeFormat(resolveIntlLocale(args.locale), {
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    });
    return episodes.map((episode) => ({
      id: episode.id,
      labelKey: ANCHOR_ILLNESS_KEY,
      label: t(ANCHOR_ILLNESS_KEY, { date: format.format(episode.onsetAt) }),
    }));
  } catch {
    return [];
  }
}

/**
 * The brake on questions, checked before one is asked: never two in a row,
 * at most one in `CLARIFY_TURN_SPACING` turns of a conversation, and at most
 * `CLARIFY_DAILY_LIMIT` a day across all of them. Over it, the question
 * becomes an assumption and the turn goes on. Unverifiable counts as over:
 * not asking is the safe side.
 */
export async function clarificationAllowed(args: {
  userId: string;
  conversationId: string;
  now?: Date;
}): Promise<boolean> {
  const now = args.now ?? new Date();
  try {
    const recent = await prisma.coachMessage.findMany({
      where: {
        conversationId: args.conversationId,
        conversation: { userId: args.userId },
        role: "assistant",
      },
      orderBy: { createdAt: "desc" },
      take: CLARIFY_TURN_SPACING - 1,
      select: { metricSourceJson: true, providerType: true },
    });
    if (
      recent.some(
        (m) =>
          m.providerType !== "cancelled" &&
          storedClarification(m.metricSourceJson) !== null,
      )
    ) {
      return false;
    }
    const dayStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const today = await prisma.coachMessage.count({
      where: {
        conversation: { userId: args.userId },
        role: "assistant",
        createdAt: { gte: dayStart },
        metricSourceJson: { contains: '"clarification":' },
      },
    });
    return today < CLARIFY_DAILY_LIMIT;
  } catch {
    return false;
  }
}
