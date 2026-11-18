"use client";

/**
 * The quick log (#1368): one screen for a carer with a phone in one hand.
 *
 * A row of the person's own seizure types (the last one used preselected),
 * one large start/stop button, and the elapsed time. When the timer passes
 * the type's threshold (Trinka's t1, or for a convulsive type the person's
 * usual duration plus two minutes when that comes first, else five minutes)
 * the type's own plan text appears with a call button for the local emergency
 * number. "Rescue given" stamps the time with the plan's drug and dose.
 * Everything else is added later in the details sheet.
 *
 * The emergency guidance stays visible the whole time. The panel never says
 * it is safe to wait: before the threshold it says nothing at all.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Phone, Pill, Play, Square, Timer } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { InlineAction } from "@/components/ui/inline-action";
import { TileHeader } from "@/components/insights/tile-header";
import { toastWrittenOutcome } from "@/components/outcome/outcome-toast";
import { localizedApiError } from "@/lib/api/localized-error";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { crisisResourcesForLocale } from "@/lib/mental-health/crisis-resources";
import { GENERIC_ALERT_SEC } from "@/lib/seizures/derive";
import type { SeizureEventDTO, SeizureTypeDTO } from "@/lib/seizures/shared";
import { cn } from "@/lib/utils";

import { formatClock, typeName } from "./seizure-format";
import { useSeizureEventMutations } from "./use-seizures";
import { useSeizureTimer } from "./use-seizure-timer";

export function QuickLogCard({
  recordId,
  types,
  lastTypeId,
  canLog,
  onRecorded,
  onLogPast,
}: {
  recordId: string;
  types: SeizureTypeDTO[];
  /** The type of the most recent seizure, preselected. */
  lastTypeId: string | null;
  canLog: boolean;
  /** Opens the details sheet for the seizure just recorded. */
  onRecorded: (event: SeizureEventDTO) => void;
  /** Opens the details sheet to record a seizure that was not timed. */
  onLogPast: () => void;
}) {
  const { t, locale } = useTranslations();
  const fmt = useFormatters();
  const timer = useSeizureTimer(recordId);
  const { create } = useSeizureEventMutations();
  const active = useMemo(() => types.filter((ty) => !ty.archived), [types]);
  const [picked, setPicked] = useState<string | null>(
    lastTypeId && active.some((ty) => ty.id === lastTypeId)
      ? lastTypeId
      : (active[0]?.id ?? null),
  );
  const [error, setError] = useState<string | null>(null);
  const [recorded, setRecorded] = useState<SeizureEventDTO | null>(null);

  const typeId = timer.running ? timer.state!.typeProfileId : picked;
  const type = active.find((ty) => ty.id === typeId);
  const alertAt = type?.alert.seconds ?? GENERIC_ALERT_SEC;
  const overThreshold = timer.running && timer.elapsed >= alertAt;
  const emergencyNumber = crisisResourcesForLocale(locale).emergencyNumber;

  // Move focus to the plan once, when it appears, so a screen reader and a
  // carer glancing back both land on it.
  const planRef = useRef<HTMLDivElement>(null);
  const announced = useRef(false);
  useEffect(() => {
    if (overThreshold && !announced.current) {
      announced.current = true;
      planRef.current?.focus();
    }
    if (!timer.running) announced.current = false;
  }, [overThreshold, timer.running]);

  function choose(id: string | null) {
    setPicked(id);
    if (timer.running) timer.setType(id);
  }

  async function stop() {
    if (!timer.state) return;
    setError(null);
    const state = timer.state;
    const durationSec = Math.max(
      1,
      Math.round((Date.now() - Date.parse(state.startedAt)) / 1000),
    );
    try {
      const event = await create.mutateAsync({
        typeProfileId: state.typeProfileId,
        onsetAt: state.startedAt,
        onsetPrecision: "EXACT",
        durationSec,
        durationSource: "TIMED",
        // Somebody ran the timer, so somebody saw it.
        witnessed: true,
        rescueDoses: state.rescue.map((r) => ({
          medicationId: r.medicationId,
          medicationName: r.medicationName,
          doseAmount: r.doseAmount,
          doseUnit: r.doseUnit,
          route: r.route,
          givenAt: r.givenAt,
        })),
      });
      timer.clear();
      setRecorded(event);
      toastWrittenOutcome("success", t("seizures.quick.recorded"));
    } catch (err) {
      // The timer keeps running and keeps its start, so nothing is lost; the
      // carer can try again or add it by hand later.
      setError(localizedApiError(err, t, "seizures.saveError"));
    }
  }

  function rescue() {
    if (!type?.rescueMedicationId && !type?.rescueMedicationName) return;
    timer.stampRescue({
      medicationId: type.rescueMedicationId,
      medicationName: type.rescueMedicationName,
      doseAmount: type.rescueDoseAmount,
      doseUnit: type.rescueDoseUnit,
      route: type.rescueRoute,
    });
  }

  const rescueCount = timer.state?.rescue.length ?? 0;

  return (
    <Card data-slot="seizure-quick-log">
      <CardHeader>
        <TileHeader icon={Timer} title={t("seizures.quick.title")} />
      </CardHeader>
      <CardContent className="space-y-4">
        <TypeChipRow types={active} selected={typeId} onChoose={choose} />

        <div className="flex flex-col items-center gap-1 py-2">
          <span
            role="timer"
            aria-live="off"
            aria-label={t("seizures.quick.elapsedLabel")}
            data-slot="seizure-elapsed"
            className="text-foreground text-5xl font-semibold tabular-nums"
          >
            {formatClock(timer.elapsed)}
          </span>
          {timer.running ? (
            <span className="text-muted-foreground text-xs">
              {t("seizures.quick.startedAt", {
                time: fmt.time(timer.state!.startedAt),
              })}
            </span>
          ) : null}
        </div>

        {canLog ? (
          <TimerControls
            running={timer.running}
            pending={create.isPending}
            rescueName={type?.rescueMedicationName ?? null}
            rescueCount={rescueCount}
            onStart={() => {
              setRecorded(null);
              timer.start(picked);
            }}
            onStop={stop}
            onRescue={rescue}
          />
        ) : null}

        {overThreshold ? (
          <ThresholdPanel
            panelRef={planRef}
            type={type}
            alertAt={alertAt}
            emergencyNumber={emergencyNumber}
          />
        ) : null}

        {error ? (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        ) : null}

        {recorded && !timer.running ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-foreground text-sm">
              {t("seizures.quick.recordedLine", {
                duration: formatClock(recorded.durationSec ?? 0),
              })}
            </p>
            <Button
              variant="outline"
              className="min-h-11 sm:min-h-9"
              onClick={() => onRecorded(recorded)}
              data-slot="seizure-add-details"
            >
              {t("seizures.quick.addDetails")}
            </Button>
          </div>
        ) : null}

        <p className="text-foreground text-sm" data-slot="seizure-safety">
          {t("seizures.safety.timer", { number: emergencyNumber })}
        </p>

        <FooterActions
          canLog={canLog}
          running={timer.running}
          onLogPast={onLogPast}
          onDiscard={() => timer.clear()}
        />
      </CardContent>
    </Card>
  );
}

function TypeChip({
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
        "focus-visible:ring-ring/50 inline-flex min-h-11 items-center rounded-full border px-3 py-1.5 text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none motion-reduce:transition-none sm:min-h-9",
        active
          ? "border-primary bg-primary/10 text-primary"
          : "border-border text-foreground hover:bg-accent",
      )}
    >
      {children}
    </button>
  );
}

/** The plan and the call button, once the timer passes the threshold. */
function ThresholdPanel({
  panelRef,
  type,
  alertAt,
  emergencyNumber,
}: {
  panelRef: React.Ref<HTMLDivElement>;
  type: SeizureTypeDTO | undefined;
  alertAt: number;
  emergencyNumber: string;
}) {
  const { t } = useTranslations();
  const planRef = panelRef;
  return (
    <div
      ref={planRef}
      tabIndex={-1}
      role="alert"
      data-slot="seizure-threshold"
      className="border-destructive/40 bg-destructive/10 space-y-3 rounded-lg border p-3 focus-visible:outline-none"
    >
      {/* `{time}` is the threshold, not the running clock, and every variant
          says "longer than": a fixed alert text that named it as the elapsed
          time contradicted the timer above it from the next second on. */}
      <p className="text-foreground text-sm font-semibold">
        {t(`seizures.quick.threshold.${type?.alert.source ?? "generic"}`, {
          time: formatClock(alertAt),
        })}
      </p>
      {type?.rescuePlan ? (
        <p className="text-foreground text-sm whitespace-pre-line">
          {type.rescuePlan}
        </p>
      ) : (
        <p className="text-foreground text-sm">{t("seizures.quick.noPlan")}</p>
      )}
      <Button asChild variant="destructive" className="min-h-12 w-full">
        <a href={`tel:${emergencyNumber}`} data-slot="seizure-call">
          <Phone className="size-4" />
          {t("seizures.quick.call", { number: emergencyNumber })}
        </a>
      </Button>
    </div>
  );
}

/** Start, or stop and "rescue given": the large targets a carer hits. */
function TimerControls({
  running,
  pending,
  rescueName,
  rescueCount,
  onStart,
  onStop,
  onRescue,
}: {
  running: boolean;
  pending: boolean;
  rescueName: string | null;
  rescueCount: number;
  onStart: () => void;
  onStop: () => void;
  onRescue: () => void;
}) {
  const { t } = useTranslations();
  if (!running) {
    return (
      <Button
        className="min-h-16 w-full text-lg"
        onClick={onStart}
        data-slot="seizure-start"
      >
        <Play className="size-5" />
        {t("seizures.quick.start")}
      </Button>
    );
  }
  return (
    <div className="space-y-2">
      <Button
        className="min-h-16 w-full text-lg"
        onClick={onStop}
        disabled={pending}
        data-slot="seizure-stop"
      >
        <Square className="size-5" />
        {t("seizures.quick.stop")}
      </Button>
      {rescueName ? (
        <Button
          variant="outline"
          className="min-h-12 w-full"
          onClick={onRescue}
          data-slot="seizure-rescue"
        >
          <Pill className="size-4" />
          {rescueCount > 0
            ? t("seizures.quick.rescueGivenCount", { count: rescueCount })
            : t("seizures.quick.rescueGiven", { name: rescueName })}
        </Button>
      ) : null}
    </div>
  );
}

/** Record an untimed seizure, or discard a timer started by mistake. */
function FooterActions({
  canLog,
  running,
  onLogPast,
  onDiscard,
}: {
  canLog: boolean;
  running: boolean;
  onLogPast: () => void;
  onDiscard: () => void;
}) {
  const { t } = useTranslations();
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      {canLog && !running ? (
        <InlineAction tone="primary" size="sm" onClick={onLogPast}>
          {t("seizures.quick.logPast")}
        </InlineAction>
      ) : (
        <span />
      )}
      {running ? (
        <ConfirmButton
          label={t("seizures.quick.discard")}
          title={t("seizures.quick.discardTitle")}
          body={t("seizures.quick.discardConfirm")}
          confirmLabel={t("seizures.quick.discard")}
          onConfirm={onDiscard}
          variant="ghost"
          size="sm"
          destructive
          slot="seizure-discard"
        />
      ) : null}
    </div>
  );
}

/** The person's own types as chips, and "no type". */
function TypeChipRow({
  types,
  selected,
  onChoose,
}: {
  types: SeizureTypeDTO[];
  selected: string | null;
  onChoose: (id: string | null) => void;
}) {
  const { t } = useTranslations();
  if (types.length === 0) return null;
  return (
    <div
      role="group"
      aria-label={t("seizures.quick.typeGroup")}
      className="flex flex-wrap gap-2"
    >
      {types.map((ty) => (
        <TypeChip
          key={ty.id}
          active={selected === ty.id}
          onClick={() => onChoose(ty.id)}
        >
          {typeName(ty, t)}
        </TypeChip>
      ))}
      <TypeChip active={selected === null} onClick={() => onChoose(null)}>
        {t("seizures.untyped")}
      </TypeChip>
    </div>
  );
}
