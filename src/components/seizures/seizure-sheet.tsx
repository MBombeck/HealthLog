"use client";

/**
 * The details of one seizure (#1368): recording one that was not timed, or
 * adding what the quick log left out. Only the onset is required; everything
 * else is optional and grouped into collapsible sections so a carer can fill
 * what they know and close it.
 *
 * Free text (aura, what was seen, the witness's note, the note) is encrypted
 * on the server. Rescue doses of a recorded seizure are listed with their
 * effect, which is usually known only afterwards.
 */
import { useState } from "react";
import { Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { DateTimeField } from "@/components/ui/date-time-field";
import { FieldGroup } from "@/components/ui/field-group";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { SheetSection } from "@/components/ui/sheet-section";
import { Textarea } from "@/components/ui/textarea";
import { toastWrittenOutcome } from "@/components/outcome/outcome-toast";
import { localizedApiError } from "@/lib/api/localized-error";
import { useTranslations } from "@/lib/i18n/context";
import { ilaeLabelKey, SEIZURE_ILAE_TYPES } from "@/lib/seizures/ilae";
import {
  SEIZURE_CERTAINTIES,
  SEIZURE_EMERGENCIES,
  SEIZURE_FUNCTION_STATES,
  SEIZURE_INJURIES,
  SEIZURE_OBSERVATIONS,
  SEIZURE_OBSERVER_ROLES,
  SEIZURE_POSTICTAL,
  SEIZURE_SEMIOLOGY,
  SEIZURE_SLEEP_STATES,
  SEIZURE_TRIGGERS,
  type SeizureEventDTO,
  type SeizureTypeDTO,
} from "@/lib/seizures/shared";
import { cn } from "@/lib/utils";

import { RescueDoses } from "./rescue-doses";
import { nowLocalValue, toLocalValue, typeName } from "./seizure-format";
import {
  useSeizureEventMutations,
  type SeizureEventBody,
} from "./use-seizures";

type Draft = {
  typeProfileId: string;
  ilaeType: string;
  onsetAt: string;
  onsetPrecision: string;
  minutes: string;
  seconds: string;
  durationSource: string;
  count: string;
  certainty: string;
  sleepState: string;
  observable: string;
  responsiveness: string;
  recall: string;
  semiology: string[];
  semiologyNote: string;
  aura: string;
  triggers: string[];
  postictalMinutes: string;
  postictal: string[];
  injuries: string[];
  emergency: string;
  incontinence: string;
  witnessed: string;
  witnessRole: string;
  witnessNote: string;
  note: string;
};

function draftOf(
  event: SeizureEventDTO | null,
  defaultType: string | null,
): Draft {
  const d = event?.durationSec ?? null;
  return {
    typeProfileId: event ? (event.typeProfileId ?? "") : (defaultType ?? ""),
    ilaeType: event?.ilaeType ?? "",
    onsetAt: event ? toLocalValue(event.onsetAt) : nowLocalValue(),
    onsetPrecision: event?.onsetPrecision ?? "APPROX",
    minutes: d === null ? "" : String(Math.floor(d / 60)),
    seconds: d === null ? "" : String(d % 60),
    durationSource: event?.durationSource ?? "ESTIMATED",
    count: String(event?.count ?? 1),
    certainty: event?.certainty ?? "CONFIRMED",
    sleepState: event?.sleepState ?? "UNKNOWN",
    observable: event?.observableManifestations ?? "",
    responsiveness: event?.responsiveness ?? "",
    recall: event?.recall ?? "",
    semiology: event?.semiology ?? [],
    semiologyNote: event?.semiologyNote ?? "",
    aura: event?.aura ?? "",
    triggers: event?.triggers ?? [],
    postictalMinutes:
      event?.postictalMinutes == null ? "" : String(event.postictalMinutes),
    postictal: event?.postictal ?? [],
    injuries: event?.injuries ?? [],
    emergency: event?.emergency ?? "NONE",
    incontinence:
      event?.incontinence == null ? "" : event.incontinence ? "yes" : "no",
    witnessed: event?.witnessed == null ? "" : event.witnessed ? "yes" : "no",
    witnessRole: event?.witnessRole ?? "",
    witnessNote: event?.witnessNote ?? "",
    note: event?.note ?? "",
  };
}

function toggle(list: string[], value: string): string[] {
  return list.includes(value)
    ? list.filter((v) => v !== value)
    : [...list, value];
}

/** The body the draft stands for; text that was emptied clears its field. */
export function bodyOf(draft: Draft): SeizureEventBody {
  const min = draft.minutes.trim() === "" ? null : Number(draft.minutes);
  const sec = draft.seconds.trim() === "" ? null : Number(draft.seconds);
  const durationSec =
    min === null && sec === null ? null : (min ?? 0) * 60 + (sec ?? 0);
  const text = (v: string) => (v.trim() ? v.trim() : null);
  return {
    typeProfileId: draft.typeProfileId || null,
    ilaeType: draft.ilaeType || null,
    onsetAt: new Date(draft.onsetAt).toISOString(),
    onsetPrecision: draft.onsetPrecision,
    durationSec,
    durationSource: durationSec === null ? "UNKNOWN" : draft.durationSource,
    count: Math.max(1, Math.round(Number(draft.count) || 1)),
    certainty: draft.certainty,
    sleepState: draft.sleepState,
    observableManifestations: draft.observable || null,
    responsiveness: draft.responsiveness || null,
    recall: draft.recall || null,
    semiology: draft.semiology,
    semiologyNote: text(draft.semiologyNote),
    aura: text(draft.aura),
    triggers: draft.triggers,
    postictalMinutes:
      draft.postictalMinutes.trim() === ""
        ? null
        : Math.max(0, Math.round(Number(draft.postictalMinutes))),
    postictal: draft.postictal,
    injuries: draft.injuries,
    emergency: draft.emergency,
    incontinence:
      draft.incontinence === "" ? null : draft.incontinence === "yes",
    witnessed: draft.witnessed === "" ? null : draft.witnessed === "yes",
    witnessRole: draft.witnessRole || null,
    witnessNote: text(draft.witnessNote),
    note: text(draft.note),
  };
}

export function SeizureSheet({
  open,
  onClose,
  event,
  types,
  defaultTypeId,
  canManage,
}: {
  open: boolean;
  onClose: () => void;
  /** The seizure to edit, or null to record a new one. */
  event: SeizureEventDTO | null;
  types: SeizureTypeDTO[];
  defaultTypeId: string | null;
  canManage: boolean;
}) {
  const { t } = useTranslations();
  const { create, update, remove } = useSeizureEventMutations();
  const [draft, setDraft] = useState<Draft>(() =>
    draftOf(event, defaultTypeId),
  );
  const [initial] = useState(() =>
    JSON.stringify(draftOf(event, defaultTypeId)),
  );
  const [error, setError] = useState<string | null>(null);
  const editing = event !== null;
  const readOnly = editing && !canManage;
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  const dirty = JSON.stringify(draft) !== initial;
  const pending = create.isPending || update.isPending;

  async function save() {
    setError(null);
    try {
      if (editing) {
        await update.mutateAsync({ id: event.id, body: bodyOf(draft) });
      } else {
        await create.mutateAsync(bodyOf(draft));
      }
      toastWrittenOutcome(
        "success",
        t(editing ? "seizures.sheet.updated" : "seizures.sheet.created"),
      );
      onClose();
    } catch (err) {
      setError(localizedApiError(err, t, "seizures.saveError"));
    }
  }

  const dp = { draft, set, readOnly };

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      dirty={dirty}
      title={t(
        editing ? "seizures.sheet.editTitle" : "seizures.sheet.newTitle",
      )}
      description={t("seizures.sheet.description")}
      footer={
        readOnly ? (
          <Button variant="outline" onClick={onClose}>
            {t("common.close")}
          </Button>
        ) : (
          <>
            <Button variant="outline" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button
              onClick={save}
              disabled={pending}
              data-slot="seizure-sheet-save"
            >
              {t("common.save")}
            </Button>
          </>
        )
      }
    >
      <div className="space-y-4">
        <CoreFields {...dp} types={types} />
        <DetailSections {...dp} />

        <FieldGroup htmlFor="seizure-note" label={t("seizures.sheet.note")}>
          <Textarea
            id="seizure-note"
            value={draft.note}
            maxLength={1000}
            disabled={readOnly}
            onChange={(e) => set("note", e.target.value)}
          />
        </FieldGroup>

        {editing ? <RescueDoses event={event} canManage={canManage} /> : null}

        {error ? (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        ) : null}

        {editing && canManage ? (
          <ConfirmButton
            label={t("seizures.sheet.delete")}
            title={t("seizures.sheet.deleteTitle")}
            body={t("seizures.sheet.deleteBody")}
            confirmLabel={t("seizures.sheet.delete")}
            icon={<Trash2 className="size-4" />}
            destructive
            pending={remove.isPending}
            slot="seizure-delete"
            onConfirm={async () => {
              try {
                await remove.mutateAsync(event.id);
                onClose();
              } catch (err) {
                setError(localizedApiError(err, t, "seizures.saveError"));
              }
            }}
          />
        ) : null}
      </div>
    </ResponsiveSheet>
  );
}

type SetDraft = <K extends keyof Draft>(key: K, value: Draft[K]) => void;
type Option = { value: string; label: string };
interface DraftProps {
  draft: Draft;
  set: SetDraft;
  readOnly: boolean;
}

/** One select bound to a draft field: `[id, label, field, options]`. */
function DraftSelect({
  draft,
  set,
  readOnly,
  args: [id, label, field, options],
}: DraftProps & { args: [string, string, keyof Draft, readonly Option[]] }) {
  return (
    <FieldGroup htmlFor={id} label={label}>
      <NativeSelect
        id={id}
        value={draft[field] as string}
        disabled={readOnly}
        onChange={(e) => set(field, e.target.value as never)}
        className="w-full"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </NativeSelect>
    </FieldGroup>
  );
}

/** The fields a seizure is recorded with: type, start, duration, certainty. */
function CoreFields({
  draft,
  set,
  readOnly,
  types,
}: DraftProps & { types: SeizureTypeDTO[] }) {
  const { t } = useTranslations();
  const dp = { draft, set, readOnly };
  return (
    <>
      <DraftSelect
        {...dp}
        args={[
          "seizure-type",
          t("seizures.sheet.type"),
          "typeProfileId",
          [
            { value: "", label: t("seizures.untyped") },
            ...types
              .filter((ty) => !ty.archived || ty.id === draft.typeProfileId)
              .map((ty) => ({ value: ty.id, label: typeName(ty, t) })),
          ],
        ]}
      />
      <FieldGroup htmlFor="seizure-onset" label={t("seizures.sheet.onset")}>
        <DateTimeField
          id="seizure-onset"
          value={draft.onsetAt}
          onChange={(v) => set("onsetAt", v)}
          max={nowLocalValue()}
          required
          disabled={readOnly}
        />
      </FieldGroup>
      <DraftSelect
        {...dp}
        args={[
          "seizure-onset-precision",
          t("seizures.sheet.onsetPrecision"),
          "onsetPrecision",
          ["EXACT", "APPROX", "UNKNOWN_TIME"].map((v) => ({
            value: v,
            label: t(`seizures.onsetPrecision.${v}`),
          })),
        ]}
      />
      <fieldset className="space-y-2">
        <legend className="pl-1 text-sm font-medium">
          {t("seizures.sheet.duration")}
        </legend>
        <div className="grid grid-cols-2 gap-4">
          <FieldGroup
            htmlFor="seizure-minutes"
            label={t("seizures.sheet.minutes")}
          >
            <Input
              id="seizure-minutes"
              inputMode="numeric"
              value={draft.minutes}
              disabled={readOnly}
              onChange={(e) =>
                set("minutes", e.target.value.replace(/\D/g, ""))
              }
            />
          </FieldGroup>
          <FieldGroup
            htmlFor="seizure-seconds"
            label={t("seizures.sheet.seconds")}
          >
            <Input
              id="seizure-seconds"
              inputMode="numeric"
              value={draft.seconds}
              disabled={readOnly}
              onChange={(e) =>
                set("seconds", e.target.value.replace(/\D/g, ""))
              }
            />
          </FieldGroup>
        </div>
        <p className="text-muted-foreground text-xs">
          {t("seizures.sheet.durationHint")}
        </p>
      </fieldset>
      {draft.minutes || draft.seconds ? (
        <DraftSelect
          {...dp}
          args={[
            "seizure-duration-source",
            t("seizures.sheet.durationSource"),
            "durationSource",
            ["TIMED", "ESTIMATED"].map((v) => ({
              value: v,
              label: t(`seizures.durationSource.${v}`),
            })),
          ]}
        />
      ) : null}
      <div className="grid grid-cols-2 gap-4">
        <DraftSelect
          {...dp}
          args={[
            "seizure-certainty",
            t("seizures.sheet.certainty"),
            "certainty",
            SEIZURE_CERTAINTIES.map((v) => ({
              value: v,
              label: t(`seizures.certainty.${v}`),
            })),
          ]}
        />
        <FieldGroup
          htmlFor="seizure-count"
          label={t("seizures.sheet.count")}
          hint={t("seizures.sheet.countHint")}
        >
          <Input
            id="seizure-count"
            inputMode="numeric"
            value={draft.count}
            disabled={readOnly}
            onChange={(e) => set("count", e.target.value.replace(/\D/g, ""))}
          />
        </FieldGroup>
      </div>
      <DraftSelect
        {...dp}
        args={[
          "seizure-sleep",
          t("seizures.sheet.sleepState"),
          "sleepState",
          SEIZURE_SLEEP_STATES.map((v) => ({
            value: v,
            label: t(`seizures.sleepState.${v}`),
          })),
        ]}
      />
    </>
  );
}

/** What came after: recovery, post-ictal state, injuries, emergency care. */
function AfterSection({ draft, set, readOnly }: DraftProps) {
  const { t } = useTranslations();
  const dp = { draft, set, readOnly };
  const notKnown = { value: "", label: t("seizures.notRecorded") };
  return (
    <SheetSection title={t("seizures.sheet.sectionAfter")}>
      <div className="space-y-4">
        <FieldGroup
          htmlFor="seizure-postictal-minutes"
          label={t("seizures.sheet.postictalMinutes")}
        >
          <Input
            id="seizure-postictal-minutes"
            inputMode="numeric"
            value={draft.postictalMinutes}
            disabled={readOnly}
            onChange={(e) =>
              set("postictalMinutes", e.target.value.replace(/\D/g, ""))
            }
          />
        </FieldGroup>
        <DraftChips
          {...dp}
          args={[
            t("seizures.sheet.postictal"),
            "postictal",
            SEIZURE_POSTICTAL,
            "seizures.postictal",
          ]}
        />
        <DraftChips
          {...dp}
          args={[
            t("seizures.sheet.injuries"),
            "injuries",
            SEIZURE_INJURIES,
            "seizures.injury",
          ]}
        />
        <DraftSelect
          {...dp}
          args={[
            "seizure-emergency",
            t("seizures.sheet.emergency"),
            "emergency",
            SEIZURE_EMERGENCIES.map((v) => ({
              value: v,
              label: t(`seizures.emergency.${v}`),
            })),
          ]}
        />
        <DraftSelect
          {...dp}
          args={[
            "seizure-incontinence",
            t("seizures.sheet.incontinence"),
            "incontinence",
            [
              notKnown,
              { value: "yes", label: t("common.yes") },
              { value: "no", label: t("common.no") },
            ],
          ]}
        />
      </div>
    </SheetSection>
  );
}

/** The optional details, folded: what was seen, afterwards, triggers and witness. */
function DetailSections({ draft, set, readOnly }: DraftProps) {
  const { t } = useTranslations();
  const dp = { draft, set, readOnly };
  const notKnown = { value: "", label: t("seizures.notRecorded") };
  return (
    <>
      <SheetSection title={t("seizures.sheet.sectionObserved")}>
        <div className="space-y-4">
          <DraftSelect
            {...dp}
            args={[
              "seizure-observable",
              t("seizures.sheet.observable"),
              "observable",
              [
                notKnown,
                ...SEIZURE_OBSERVATIONS.map((v) => ({
                  value: v,
                  label: t(`seizures.observation.${v}`),
                })),
              ],
            ]}
          />
          <DraftSelect
            {...dp}
            args={[
              "seizure-responsiveness",
              t("seizures.sheet.responsiveness"),
              "responsiveness",
              [
                notKnown,
                ...SEIZURE_FUNCTION_STATES.map((v) => ({
                  value: v,
                  label: t(`seizures.functionState.${v}`),
                })),
              ],
            ]}
          />
          <DraftSelect
            {...dp}
            args={[
              "seizure-recall",
              t("seizures.sheet.recall"),
              "recall",
              [
                notKnown,
                ...SEIZURE_FUNCTION_STATES.map((v) => ({
                  value: v,
                  label: t(`seizures.functionState.${v}`),
                })),
              ],
            ]}
          />
          <DraftChips
            {...dp}
            args={[
              t("seizures.sheet.semiology"),
              "semiology",
              SEIZURE_SEMIOLOGY,
              "seizures.semiology",
            ]}
          />
          <FieldGroup
            htmlFor="seizure-semiology-note"
            label={t("seizures.sheet.semiologyNote")}
          >
            <Textarea
              id="seizure-semiology-note"
              value={draft.semiologyNote}
              maxLength={1000}
              disabled={readOnly}
              onChange={(e) => set("semiologyNote", e.target.value)}
            />
          </FieldGroup>
          <FieldGroup htmlFor="seizure-aura" label={t("seizures.sheet.aura")}>
            <Input
              id="seizure-aura"
              value={draft.aura}
              maxLength={1000}
              disabled={readOnly}
              onChange={(e) => set("aura", e.target.value)}
            />
          </FieldGroup>
          <DraftSelect
            {...dp}
            args={[
              "seizure-ilae-override",
              t("seizures.sheet.ilaeOverride"),
              "ilaeType",
              [
                { value: "", label: t("seizures.sheet.ilaeFromType") },
                ...SEIZURE_ILAE_TYPES.map((v) => ({
                  value: v,
                  label: t(ilaeLabelKey(v)),
                })),
              ],
            ]}
          />
        </div>
      </SheetSection>

      <AfterSection {...dp} />

      <SheetSection title={t("seizures.sheet.sectionContext")}>
        <div className="space-y-4">
          <DraftChips
            {...dp}
            args={[
              t("seizures.sheet.triggers"),
              "triggers",
              SEIZURE_TRIGGERS,
              "seizures.trigger",
            ]}
          />
          <p className="text-muted-foreground text-xs">
            {t("seizures.sheet.triggersHint")}
          </p>
          <DraftSelect
            {...dp}
            args={[
              "seizure-witnessed",
              t("seizures.sheet.witnessed"),
              "witnessed",
              [
                notKnown,
                { value: "yes", label: t("common.yes") },
                { value: "no", label: t("common.no") },
              ],
            ]}
          />
          <DraftSelect
            {...dp}
            args={[
              "seizure-witness-role",
              t("seizures.sheet.witnessRole"),
              "witnessRole",
              [
                notKnown,
                ...SEIZURE_OBSERVER_ROLES.map((v) => ({
                  value: v,
                  label: t(`seizures.observer.${v}`),
                })),
              ],
            ]}
          />
          <FieldGroup
            htmlFor="seizure-witness-note"
            label={t("seizures.sheet.witnessNote")}
          >
            <Textarea
              id="seizure-witness-note"
              value={draft.witnessNote}
              maxLength={1000}
              disabled={readOnly}
              onChange={(e) => set("witnessNote", e.target.value)}
            />
          </FieldGroup>
        </div>
      </SheetSection>
    </>
  );
}

type ChipField = "semiology" | "triggers" | "postictal" | "injuries";

/** A row of toggle chips bound to a list field: `[label, field, values, i18n prefix]`. */
function DraftChips({
  draft,
  set,
  readOnly,
  args: [label, field, values, prefix],
}: DraftProps & { args: [string, ChipField, readonly string[], string] }) {
  const { t } = useTranslations();
  return (
    <fieldset className="space-y-2">
      <legend className="pl-1 text-sm font-medium">{label}</legend>
      <div className="flex flex-wrap gap-2">
        {values.map((v) => (
          <Chip
            key={v}
            active={draft[field].includes(v)}
            disabled={readOnly}
            onClick={() => set(field, toggle(draft[field], v))}
          >
            {t(`${prefix}.${v}`)}
          </Chip>
        ))}
      </div>
    </fieldset>
  );
}

function Chip({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "focus-visible:ring-ring/50 inline-flex min-h-11 items-center rounded-full border px-3 py-1.5 text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:opacity-50 motion-reduce:transition-none sm:min-h-8",
        active
          ? "border-primary bg-primary/10 text-primary"
          : "border-border text-foreground hover:bg-accent",
      )}
    >
      {children}
    </button>
  );
}
