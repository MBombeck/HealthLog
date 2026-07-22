"use client";

import { useId, useState } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { DateTimeField } from "@/components/ui/date-time-field";
import { FieldGroup } from "@/components/ui/field-group";
import { Label } from "@/components/ui/label";
import {
  ListChecks,
  Loader2,
  MoreHorizontal,
  Plus,
  RotateCcw,
  SlidersHorizontal,
  StickyNote,
} from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "@/lib/i18n/context";
import { useRovingRadioGroup } from "@/hooks/use-roving-radio-group";
import {
  invalidateKeys,
  moodDependentKeys,
  refetchInactiveDailyReads,
} from "@/lib/query-keys";
import { apiPost } from "@/lib/api/api-fetch";
import { localizedApiError } from "@/lib/api/localized-error";
import { SheetSection, SheetSectionCount } from "@/components/ui/sheet-section";
import { MoodTagPicker, type RatedFactor } from "./mood-tag-picker";
import { MoodQuickTags } from "./mood-quick-tags";
import { useRecentTags } from "./recent-tags";
import { moodFaceIcon } from "./mood-tag-icons";

// v1.12.0 — best-on-the-left face order for the "How are you?" hero,
// mirroring the iOS `Mood1…Mood5` imageset order. The numeric `score`
// is the server's 1..5 scale; the face icon resolves through
// `moodFaceIcon`.
const MOOD_LEVELS = [
  { value: "SUPER_GUT", score: 5, labelKey: "mood.levelSuperGut" },
  { value: "GUT", score: 4, labelKey: "mood.levelGut" },
  { value: "OKAY", score: 3, labelKey: "mood.levelOkay" },
  { value: "SCHLECHT", score: 2, labelKey: "mood.levelSchlecht" },
  { value: "LAUSIG", score: 1, labelKey: "mood.levelLausig" },
] as const;

// v1.8.5 (C1) — note free-text limit. Mirrors the `maxLength` on the
// textarea and the server-side Zod bound; surfaced as a character counter
// so the truncation at the cap is no longer silent.
const NOTE_MAX_LENGTH = 500;

/**
 * v1.4.25 W4d — curated GLP-1 side-effect chip strip. Tapping a chip
 * appends the localised tag string to the existing free-text tag input
 * (comma-separated). The list is intentionally short — these are the
 * symptoms clinicians most often ask about at GLP-1 follow-up visits
 * (cf. PMC GLP-1 adverse-effects review). Generic mood entries that
 * never touch the chips keep their tag input byte-identical to v1.4.24.
 */
const GLP1_SIDE_EFFECT_KEYS = [
  "medications.sideEffectTagNausea",
  "medications.sideEffectTagConstipation",
  "medications.sideEffectTagDiarrhea",
  "medications.sideEffectTagFatigue",
  "medications.sideEffectTagAppetiteLoss",
  "medications.sideEffectTagHeartburn",
  "medications.sideEffectTagHeadache",
] as const;

interface MoodFormProps {
  onSuccess?: () => void;
  onCancel?: () => void;
  /**
   * v1.4.27 R4 RC2 — when the form is mounted inside a
   * `<ResponsiveSheet>` the caller can pass the sheet's footer slot
   * element here. The action-row (kebab + Cancel + Save) is portalled
   * into that slot so the bottom-sheet branch can sticky-pin it; the
   * Save button stays inside the logical `<form>` via the HTML `form`
   * attribute so submit-on-Enter still works.
   */
  footerSlot?: HTMLElement | null;
}

function getDefaultMoodLoggedAtValue() {
  const now = new Date();
  const offset = now.getTimezoneOffset();
  const local = new Date(now.getTime() - offset * 60 * 1000);
  return local.toISOString().slice(0, 16);
}

export function MoodForm({ onSuccess, onCancel, footerSlot }: MoodFormProps) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();

  const [mood, setMood] = useState("");
  const { getRadioProps: getMoodRadioProps } = useRovingRadioGroup({
    count: MOOD_LEVELS.length,
    selectedIndex: MOOD_LEVELS.findIndex((l) => l.value === mood),
    onSelect: (index) => setMood(MOOD_LEVELS[index]!.value),
  });
  const [tagsInput, setTagsInput] = useState("");
  // v1.8.5 — structured-tag keys picked from the taxonomy catalog.
  const [tagKeys, setTagKeys] = useState<string[]>([]);
  // v1.12.0 — rated mood factors (FACTOR-kind catalog tags scored on
  // their own 1..scaleMax scale). Sent as `ratedFactors: [{key,rating}]`.
  const [ratedFactors, setRatedFactors] = useState<RatedFactor[]>([]);
  // v1.8.5 (C1) — first-class free-text note. The model + API already
  // accepted `note`; the web form was the only surface that couldn't
  // write it.
  const [note, setNote] = useState("");
  const [moodLoggedAt, setMoodLoggedAt] = useState(getDefaultMoodLoggedAtValue);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // v1.11.5 — confirm before Reset wipes typed input. Only the content
  // fields the user actively fills count toward "dirty"; the timestamp
  // always carries an auto-populated default, so it is excluded.
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  // v1.17.0 — MRU tag history powers the always-open Quick row; tapping the
  // Quick row's "+" expands the full "More tags" section (controlled so the
  // chip can open it).
  const { recent, recordUse } = useRecentTags();
  const [moreTagsOpen, setMoreTagsOpen] = useState(false);
  const isDirty =
    mood !== "" ||
    tagsInput.trim() !== "" ||
    tagKeys.length > 0 ||
    ratedFactors.length > 0 ||
    note.trim() !== "";

  function toggleTagKey(key: string) {
    setTagKeys((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
    );
  }

  // v1.12.0 — set or clear a rated factor's score. `rating === null`
  // removes the factor from the set (re-tapping the active step clears).
  function rateFactor(key: string, rating: number | null) {
    setRatedFactors((prev) => {
      const rest = prev.filter((f) => f.key !== key);
      return rating === null ? rest : [...rest, { key, rating }];
    });
  }

  // v1.4.27 MB3 — error banner descriptor for the timestamp input.
  const errorId = useId();
  const errorDescriptor = error ? errorId : undefined;

  // v1.4.27 R4 RC2 — stable form id so the portalled Save button can
  // associate with this `<form>` element via the HTML `form` attribute
  // even when DOM-mounted inside the `<ResponsiveSheet>` footer slot.
  const formId = useId();

  function resetForm() {
    setMood("");
    setTagsInput("");
    setTagKeys([]);
    setRatedFactors([]);
    setNote("");
    setMoodLoggedAt(getDefaultMoodLoggedAtValue());
    setError(null);
  }

  // v1.11.5 — Reset confirms first when the form holds typed input, so a
  // mis-tap can't silently discard a half-written entry. A pristine form
  // resets immediately (nothing to lose).
  function requestReset() {
    if (isDirty) {
      setResetConfirmOpen(true);
    } else {
      resetForm();
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!mood) return;
    setError(null);
    setLoading(true);

    try {
      const timestamp = new Date(moodLoggedAt).toISOString();
      const tags = tagsInput
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);

      const trimmedNote = note.trim();

      await apiPost("/api/mood-entries", {
        mood,
        tags: tags.length > 0 ? tags : undefined,
        tagKeys: tagKeys.length > 0 ? tagKeys : undefined,
        // v1.12.0 — rated factors as a parallel [{key,rating}] array.
        ratedFactors: ratedFactors.length > 0 ? ratedFactors : undefined,
        note: trimmedNote.length > 0 ? trimmedNote : undefined,
        moodLoggedAt: timestamp,
      });

      // v1.17.0 — promote the saved structured tags to the Quick row's MRU
      // history so the next entry surfaces them as one-tap chips.
      if (tagKeys.length > 0) recordUse(tagKeys);
      resetForm();
      setMoreTagsOpen(false);
      await invalidateKeys(queryClient, moodDependentKeys);
      await refetchInactiveDailyReads(queryClient);
      toast.success(t("common.saved"));
      onSuccess?.();
    } catch (err) {
      setError(localizedApiError(err, t, "mood.saveError"));
    } finally {
      setLoading(false);
    }
  }

  const footerNode = (
    <div className="flex w-full items-center justify-between gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="h-11 w-11"
            disabled={loading}
            aria-label={t("common.moreOptions")}
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onClick={requestReset}>
            <RotateCcw className="mr-2 h-4 w-4" />
            {t("mood.formReset")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <div className="flex items-center gap-2">
        {onCancel && (
          <Button
            type="button"
            variant="outline"
            onClick={onCancel}
            disabled={loading}
          >
            {t("common.cancel")}
          </Button>
        )}
        <Button type="submit" form={formId} disabled={loading || !mood}>
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
          ) : (
            <Plus className="h-4 w-4" />
          )}
          {t("common.save")}
        </Button>
      </div>
    </div>
  );

  // v1.12.0 — the annotate panel (tags / factors / note / time) reveals
  // only after a mood face is picked, so the icon-first hero is the
  // primary input and a fast log is a single tap + Save.
  const moodPicked = mood !== "";

  // v1.17.0 — the "Note & details" badge counts the free-text tags entered
  // plus the note (when present), so a collapsed section communicates what
  // it holds.
  const freeTextTagCount = tagsInput
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean).length;
  const detailsCount = freeTextTagCount + (note.trim() ? 1 : 0);

  return (
    <form id={formId} onSubmit={handleSubmit} className="space-y-4">
      {/* v1.12.0 — "How are you?" 5-face hero. The five faces are a
          radiogroup (best-on-the-left order); tapping one picks the mood
          and reveals the annotate panel below. */}
      <div className="space-y-2" data-slot="mood-face-hero">
        {/* v1.12 — the sheet title ("Add") is the single primary heading;
            the hero question stays as the face row's field label rather
            than a second heading-weight line, so the sheet header isn't a
            doubled heading. */}
        <Label
          id="mood-level-label"
          className="text-muted-foreground text-sm font-normal"
        >
          {t("mood.heroQuestion")}
        </Label>
        <div
          role="radiogroup"
          aria-labelledby="mood-level-label"
          className="grid grid-cols-5 gap-1.5 sm:gap-2"
        >
          {MOOD_LEVELS.map((level, index) => {
            const isSelected = mood === level.value;
            const FaceIcon = moodFaceIcon(level.value);
            return (
              <button
                key={level.value}
                type="button"
                role="radio"
                aria-checked={isSelected}
                aria-label={t(level.labelKey)}
                data-slot="mood-face"
                data-mood={level.value}
                onClick={() => setMood(level.value)}
                {...getMoodRadioProps(index)}
                // v1.12 — selected-state unified with the tag tiles and
                // factor steps: `border-primary bg-primary/15 text-primary`
                // on a single 1px border (no `border-2` jump) so the
                // selectable controls read as one design language.
                className={`flex flex-col items-center gap-1.5 rounded-xl border p-2 text-center transition-colors sm:p-3 ${
                  isSelected
                    ? "border-primary bg-primary/15 text-primary"
                    : "border-border text-muted-foreground hover:bg-accent hover:text-foreground"
                }`}
              >
                <FaceIcon
                  className="h-7 w-7 sm:h-8 sm:w-8"
                  aria-hidden="true"
                />
                <span className="text-[10px] leading-tight sm:text-xs">
                  {t(level.labelKey)}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {moodPicked && (
        <div className="space-y-3" data-slot="mood-annotate-panel">
          {/* v1.17.0 — always-open Quick row: MRU one-tap tags + a "+" that
              expands the full "More tags" section. The common case stays a
              face + a couple of taps + Save. */}
          <MoodQuickTags
            selected={tagKeys}
            onToggle={toggleTagKey}
            recent={recent}
            onExpand={() => setMoreTagsOpen(true)}
          />

          <FieldGroup htmlFor="mood-logged-at" label={t("mood.timestamp")}>
            <DateTimeField
              id="mood-logged-at"
              value={moodLoggedAt}
              onChange={setMoodLoggedAt}
              // v1.17 W1b — match the server bound: no future instant.
              max={getDefaultMoodLoggedAtValue()}
              required
              aria-required="true"
              aria-invalid={!!error || undefined}
              aria-describedby={errorDescriptor}
            />
          </FieldGroup>

          {/* v1.17.0 — "More tags": the full structured-tag taxonomy
              (binary tiles + custom). Controlled so the Quick row's "+" can
              open it; the badge reports how many tags are selected. */}
          <SheetSection
            title={t("mood.sectionMoreTags")}
            icon={<ListChecks />}
            open={moreTagsOpen}
            onOpenChange={setMoreTagsOpen}
            summary={<SheetSectionCount count={tagKeys.length} />}
          >
            <MoodTagPicker
              selected={tagKeys}
              onToggle={toggleTagKey}
              mode="binary"
            />
          </SheetSection>

          {/* v1.17.0 — "Factors": the FACTOR-kind segmented ratings, kept
              exactly as the existing segmented control. */}
          <SheetSection
            title={t("mood.sectionFactors")}
            icon={<SlidersHorizontal />}
            summary={<SheetSectionCount count={ratedFactors.length} />}
          >
            <MoodTagPicker
              selected={tagKeys}
              onToggle={toggleTagKey}
              ratedFactors={ratedFactors}
              onRateFactor={rateFactor}
              mode="rated"
            />
          </SheetSection>

          {/* v1.17.0 — "Note & details": free-text tags, GLP-1 quick-tags,
              and the note field. The badge counts whichever of these carry
              input. */}
          <SheetSection
            title={t("mood.sectionNoteDetails")}
            icon={<StickyNote />}
            summary={<SheetSectionCount count={detailsCount} />}
          >
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="tags">
                  {t("mood.tags")}{" "}
                  <span className="text-muted-foreground font-normal">
                    ({t("common.optional")})
                  </span>
                </Label>
                <span className="text-muted-foreground text-xs">
                  {t("mood.tagsHelp")}
                </span>
              </div>
              <Input
                id="tags"
                value={tagsInput}
                onChange={(e) => setTagsInput(e.target.value)}
                placeholder={t("mood.tagsPlaceholder")}
                enterKeyHint="done"
                autoCapitalize="none"
                autoComplete="off"
              />
              {/* v1.4.25 W4d — GLP-1 side-effect quick-tags. Tapping a chip
              appends the localised label to the free-text tag list.
              Always visible for now (cheap UX; the Coach side-effect
              aggregator filters on the canonical English tag set so the
              German labels still register correctly). */}
              <div className="space-y-1.5 pt-1">
                <p className="text-muted-foreground text-xs">
                  {t("medications.sideEffectTagsHelp")}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {GLP1_SIDE_EFFECT_KEYS.map((key) => {
                    const label = t(key);
                    const tags = tagsInput
                      .split(",")
                      .map((p) => p.trim().toLowerCase());
                    const isActive = tags.includes(label.toLowerCase());
                    return (
                      <button
                        key={key}
                        type="button"
                        onClick={() => {
                          if (isActive) {
                            const next = tagsInput
                              .split(",")
                              .map((p) => p.trim())
                              .filter(
                                (p) => p.toLowerCase() !== label.toLowerCase(),
                              );
                            setTagsInput(next.join(", "));
                          } else {
                            const next = tagsInput.trim()
                              ? `${tagsInput.replace(/[,\s]+$/, "")}, ${label}`
                              : label;
                            setTagsInput(next);
                          }
                        }}
                        className={`inline-flex min-h-11 items-center rounded-full border px-3 py-2 text-xs transition-colors ${
                          isActive
                            ? "border-primary bg-primary/15 text-primary"
                            : "border-border/70 bg-muted text-foreground/75 hover:bg-accent hover:text-foreground"
                        }`}
                        aria-pressed={isActive}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* v1.8.5 (C1) — free-text note. */}
            <FieldGroup
              htmlFor="mood-note"
              label={
                <>
                  {t("mood.note")}{" "}
                  <span className="text-muted-foreground font-normal">
                    ({t("common.optional")})
                  </span>
                </>
              }
              labelAccessory={
                /* v1.11.5 — character counter so the `maxLength` cap no
                longer truncates silently. Turns destructive (warns) as the
                input approaches the limit. */
                <span
                  data-testid="mood-note-counter"
                  className={`text-xs tabular-nums ${
                    note.length >= NOTE_MAX_LENGTH
                      ? "text-destructive"
                      : "text-muted-foreground"
                  }`}
                  aria-live="polite"
                >
                  {t("mood.noteCharCount", {
                    count: String(note.length),
                    max: String(NOTE_MAX_LENGTH),
                  })}
                </span>
              }
            >
              <Textarea
                id="mood-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={t("mood.notePlaceholder")}
                maxLength={NOTE_MAX_LENGTH}
                rows={3}
              />
            </FieldGroup>
          </SheetSection>
        </div>
      )}

      {error && (
        <div
          id={errorId}
          role="alert"
          aria-live="assertive"
          className="bg-destructive/10 text-destructive rounded-lg p-3 text-sm"
        >
          {error}
        </div>
      )}

      {footerSlot ? createPortal(footerNode, footerSlot) : footerNode}

      {/* v1.11.5 — Reset confirmation. Only opened by `requestReset` when
          the form is dirty; a pristine form skips it entirely. */}
      <AlertDialog open={resetConfirmOpen} onOpenChange={setResetConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("mood.formResetConfirmTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("mood.formResetConfirmBody")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={resetForm}>
              {t("mood.formResetConfirmAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </form>
  );
}
