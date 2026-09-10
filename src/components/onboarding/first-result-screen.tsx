"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { CheckCircle2, Loader2 } from "lucide-react";

import { MeasurementForm } from "@/components/measurements/measurement-form";
import { MEASUREMENT_TYPE_LABEL_KEYS } from "@/components/measurements/measurement-list-meta";
import { MedicationWizardDialog } from "@/components/medications/wizard/medication-wizard-dialog";
import { StepActions } from "@/components/onboarding/step-actions";
import { StepHeading } from "@/components/onboarding/step-heading";
import {
  screenHref,
  useOnboardingAnswer,
} from "@/components/onboarding/use-onboarding-flow";
import {
  pickStatus,
  useIntegrationStatuses,
  type IntegrationKey,
} from "@/components/settings/integrations/shared";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { useUnitDisplay } from "@/hooks/use-unit-display";
import { apiGet } from "@/lib/api/api-fetch";
import { localizedApiError } from "@/lib/api/localized-error";
import { convertGlucose, resolveGlucoseUnit } from "@/lib/glucose";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import type { OnboardingAreaKey } from "@/lib/modules/registry";
import {
  AREA_PAGE_HREF,
  AREA_READING_TARGETS,
  SOURCE_INTEGRATION,
} from "@/lib/onboarding/first-result-config";
import type { OnboardingStateDto } from "@/lib/onboarding/needs";
import { questionOptionLabelKey } from "@/lib/onboarding/question-config";
import {
  chooseFirstResultTask,
  isBrowserConnectableSource,
  previousScreen,
  type BrowserConnectableSource,
} from "@/lib/onboarding/wizard-steps";
import { queryKeys } from "@/lib/query-keys";

/**
 * v1.39 (C2) — the one task the flow ends on.
 *
 * Exactly one of three, chosen by the step machine's fixed priority: connect
 * the wearable named in Q4, add the first medication, or log one reading for
 * the first Q2 area. The form is inline where a form exists (the measurement
 * form, the medication wizard); a connection goes through the integrations
 * page, because the OAuth handshake cannot run inside this screen, and this
 * screen watches the status envelope for it to come back connected.
 *
 * On completion the screen shows what the task produced — the reading on its
 * tile, the medication with its next dose, the connection with "first sync in
 * progress" — and records the result on the ledger with the server's own
 * instant. The offer itself is not recorded on arrival: a person who leaves
 * mid-task then resumes HERE rather than on the done screen, and the ledger
 * reads as owed rather than as an offer nobody acted on.
 */
type Offer = NonNullable<ReturnType<typeof chooseFirstResultTask>>;

export function FirstResultScreen({ state }: { state: OnboardingStateDto }) {
  const { t } = useTranslations();
  const router = useRouter();
  const answer = useOnboardingAnswer();
  const offer = chooseFirstResultTask(state.needs);
  const back = previousScreen(state, "first-result");

  const [completed, setCompleted] = useState(
    state.firstResult?.task === offer?.task &&
      state.firstResult?.completedAt !== null,
  );
  const [resultTarget, setResultTarget] = useState<string | null>(
    state.firstResult?.target ?? null,
  );

  async function complete(target: string | null) {
    if (!offer) return;
    try {
      await answer.mutateAsync({
        step: "first-result",
        firstResult: { task: offer.task, target, completed: true },
      });
      setResultTarget(target);
      setCompleted(true);
    } catch (err) {
      toast.error(localizedApiError(err, t, "onboarding.errorGeneric"));
    }
  }

  async function skip() {
    try {
      await answer.mutateAsync({ step: "first-result", status: "skipped" });
      router.push(screenHref("done"));
    } catch (err) {
      toast.error(localizedApiError(err, t, "onboarding.errorGeneric"));
    }
  }

  // The page guard only renders this screen while the machine puts it in the
  // order, so an offer is always there; the arm keeps the type total.
  useEffect(() => {
    if (!offer) router.replace(screenHref("done"));
  }, [offer, router]);
  if (!offer) return null;

  return (
    <section
      aria-labelledby="onboarding-first-result-title"
      className="space-y-6"
      data-task={offer.task}
      data-target={offer.target ?? undefined}
    >
      <StepHeading
        id="onboarding-first-result-title"
        title={t(`onboarding.flow.first-result.${offer.task}.title`, {
          target: targetLabel(t, offer),
        })}
        description={t(`onboarding.flow.first-result.${offer.task}.body`)}
      />

      <TaskBody
        offer={offer}
        completed={completed}
        resultTarget={resultTarget}
        onComplete={complete}
      />

      <StepActions
        backHref={back ? screenHref(back) : undefined}
        onSkip={completed ? undefined : () => void skip()}
        onNext={completed ? () => router.push(screenHref("done")) : undefined}
        pending={answer.isPending}
      />
    </section>
  );
}

function targetLabel(
  t: (key: string, params?: Record<string, string | number>) => string,
  offer: Offer,
): string {
  if (!offer.target) return "";
  if (offer.task === "connect-source") {
    return t(questionOptionLabelKey("sources", offer.target));
  }
  return t(questionOptionLabelKey("areas", offer.target));
}

function TaskBody({
  offer,
  completed,
  resultTarget,
  onComplete,
}: {
  offer: Offer;
  completed: boolean;
  resultTarget: string | null;
  onComplete: (target: string | null) => Promise<void>;
}) {
  switch (offer.task) {
    case "connect-source":
      return offer.target && isBrowserConnectableSource(offer.target) ? (
        <ConnectSourceTask
          source={offer.target}
          completed={completed}
          onComplete={onComplete}
        />
      ) : null;
    case "add-medication":
      return (
        <AddMedicationTask
          completed={completed}
          medicationId={resultTarget}
          onComplete={onComplete}
        />
      );
    case "log-reading":
      return offer.target ? (
        <LogReadingTask
          area={offer.target as OnboardingAreaKey}
          completed={completed}
          onComplete={onComplete}
        />
      ) : null;
  }
}

/* ── connect a source ──────────────────────────────────────────────────── */

function ConnectSourceTask({
  source,
  completed,
  onComplete,
}: {
  source: BrowserConnectableSource;
  completed: boolean;
  onComplete: (target: string | null) => Promise<void>;
}) {
  const { t } = useTranslations();
  const { anchor, statusKey } = SOURCE_INTEGRATION[source];
  const label = t(questionOptionLabelKey("sources", source));
  // Refetches on window focus, so coming back from the integrations tab
  // after the handshake picks the fresh verdict up on its own.
  const statuses = useIntegrationStatuses(true);
  const status = pickStatus(statuses.data, statusKey as IntegrationKey);
  const connected = status?.connected === true || status?.state === "connected";

  // Record the result once the connection is there — once. `completed` flips
  // only after the write resolves, and the status envelope can re-render this
  // in between, so a ref latches the first call.
  const recorded = useRef(completed);
  useEffect(() => {
    if (connected && !recorded.current) {
      recorded.current = true;
      void onComplete(source);
    }
  }, [connected, onComplete, source]);

  if (completed || connected) {
    return (
      <ResultTile
        title={t("onboarding.flow.first-result.connect-source.done", {
          target: label,
        })}
        detail={t("onboarding.flow.first-result.connect-source.syncing")}
      />
    );
  }

  return (
    <div
      className="bg-card border-border space-y-4 rounded-xl border p-4 md:p-6"
      data-slot="onboarding-task-connect"
    >
      <p className="text-sm">
        {t("onboarding.flow.first-result.connect-source.howTo", {
          target: label,
        })}
      </p>
      <Button asChild className="min-h-11">
        <Link href={`/settings/integrations#${anchor}`}>
          {t("onboarding.flow.first-result.connect-source.cta", {
            target: label,
          })}
        </Link>
      </Button>
      <p className="text-muted-foreground text-xs" aria-live="polite">
        {statuses.isLoading
          ? t("onboarding.flow.first-result.connect-source.checking")
          : t("onboarding.flow.first-result.connect-source.waiting")}
      </p>
    </div>
  );
}

/* ── add a medication ──────────────────────────────────────────────────── */

interface MedicationDetail {
  name: string;
  nextDueAt: string | null;
}

function AddMedicationTask({
  completed,
  medicationId,
  onComplete,
}: {
  completed: boolean;
  medicationId: string | null;
  onComplete: (target: string | null) => Promise<void>;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const [open, setOpen] = useState(false);

  const detail = useQuery({
    queryKey: queryKeys.medicationDetail(medicationId ?? ""),
    queryFn: () => apiGet<MedicationDetail>(`/api/medications/${medicationId}`),
    enabled: completed && medicationId !== null,
  });

  if (completed) {
    return (
      <ResultTile
        title={
          detail.data
            ? t("onboarding.flow.first-result.add-medication.done", {
                name: detail.data.name,
              })
            : t("onboarding.flow.first-result.add-medication.doneUnnamed")
        }
        detail={
          detail.data?.nextDueAt
            ? t("onboarding.flow.first-result.add-medication.nextDose", {
                when: fmt.dateTime(detail.data.nextDueAt),
              })
            : t("onboarding.flow.first-result.add-medication.reminders")
        }
      />
    );
  }

  return (
    <div
      className="bg-card border-border space-y-4 rounded-xl border p-4 md:p-6"
      data-slot="onboarding-task-medication"
    >
      <p className="text-sm">
        {t("onboarding.flow.first-result.add-medication.howTo")}
      </p>
      <Button
        type="button"
        className="min-h-11"
        onClick={() => setOpen(true)}
        data-slot="onboarding-add-medication"
      >
        {t("onboarding.flow.first-result.add-medication.cta")}
      </Button>
      <MedicationWizardDialog
        open={open}
        onOpenChange={setOpen}
        mode="create"
        onSuccess={(id) => {
          setOpen(false);
          void onComplete(id);
        }}
      />
    </div>
  );
}

/* ── log one reading ───────────────────────────────────────────────────── */

function LogReadingTask({
  area,
  completed,
  onComplete,
}: {
  area: OnboardingAreaKey;
  completed: boolean;
  onComplete: (target: string | null) => Promise<void>;
}) {
  const { t } = useTranslations();
  const target = AREA_READING_TARGETS[area];
  const href = AREA_PAGE_HREF[area];
  const label = t(questionOptionLabelKey("areas", area));

  if (completed && target) {
    return <LatestReadingTile area={area} storedTypes={target.storedTypes} />;
  }
  if (completed) {
    return (
      <ResultTile
        title={t("onboarding.flow.first-result.log-reading.doneElsewhere", {
          target: label,
        })}
      />
    );
  }

  if (target) {
    return (
      <div
        className="bg-card border-border rounded-xl border p-4 md:p-6"
        data-slot="onboarding-task-reading"
      >
        <MeasurementForm
          defaultType={target.formType}
          onSuccess={() => void onComplete(area)}
        />
      </div>
    );
  }

  // An area with its own surface: point there, and let the person say when
  // it is done — nothing here can see a mood entry or an episode land.
  return (
    <div
      className="bg-card border-border space-y-4 rounded-xl border p-4 md:p-6"
      data-slot="onboarding-task-reading-link"
    >
      <p className="text-sm">
        {t("onboarding.flow.first-result.log-reading.elsewhere", {
          target: label,
        })}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button asChild className="min-h-11">
          <Link href={href ?? "/"}>
            {t("onboarding.flow.first-result.log-reading.open", {
              target: label,
            })}
          </Link>
        </Button>
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          onClick={() => void onComplete(area)}
          data-slot="onboarding-reading-done"
        >
          {t("onboarding.flow.first-result.log-reading.markDone")}
        </Button>
      </div>
    </div>
  );
}

interface MeasurementRow {
  type: string;
  value: number;
  measuredAt: string;
}

function LatestReadingTile({
  area,
  storedTypes,
}: {
  area: OnboardingAreaKey;
  storedTypes: readonly string[];
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const { user } = useAuth();
  const units = useUnitDisplay();
  const glucoseUnit = resolveGlucoseUnit(user?.glucoseUnit);

  const latest = useQuery({
    queryKey: queryKeys.onboardingLatestReading(area),
    queryFn: async () =>
      Promise.all(
        storedTypes.map((type) =>
          apiGet<MeasurementRow[]>(
            `/api/measurements?type=${encodeURIComponent(type)}&limit=1`,
          ).then((rows) => rows[0] ?? null),
        ),
      ),
  });

  const rows = (latest.data ?? []).filter(
    (row): row is MeasurementRow => row !== null,
  );

  if (latest.isPending) {
    return (
      <div
        className="text-muted-foreground flex items-center gap-2 text-sm"
        role="status"
      >
        <Loader2
          aria-hidden="true"
          className="size-4 animate-spin motion-reduce:animate-none"
        />
        {t("common.loading")}
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <ResultTile title={t("onboarding.flow.first-result.log-reading.done")} />
    );
  }

  let value: string;
  let unit: string;
  if (area === "blood-pressure") {
    const sys = rows.find((r) => r.type === "BLOOD_PRESSURE_SYS");
    const dia = rows.find((r) => r.type === "BLOOD_PRESSURE_DIA");
    value = `${sys ? fmt.integer(sys.value) : "–"}/${dia ? fmt.integer(dia.value) : "–"}`;
    unit = "mmHg";
  } else if (area === "glucose") {
    const row = rows[0];
    value = fmt.number(
      convertGlucose(row.value, glucoseUnit),
      glucoseUnit === "mmol/L" ? 1 : 0,
    );
    unit = glucoseUnit;
  } else if (area === "sleep") {
    // Stored in minutes since v1.4.23.
    const minutes = Math.round(rows[0].value);
    value = `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
    unit = t("measurements.unitHours");
  } else {
    const row = rows[0];
    value = fmt.number(
      units.toDisplay(row.type, row.value),
      units.decimalsFor(row.type),
    );
    unit = units.unitFor(row.type);
  }
  const label = t(MEASUREMENT_TYPE_LABEL_KEYS[rows[0].type] ?? "");

  return (
    <ResultTile
      title={t("onboarding.flow.first-result.log-reading.done")}
      detail={`${area === "blood-pressure" ? t("measurements.typeBloodPressure") : label}: ${value} ${unit} · ${fmt.dateTime(rows[0].measuredAt)}`}
    />
  );
}

/* ── the result ────────────────────────────────────────────────────────── */

function ResultTile({ title, detail }: { title: string; detail?: string }) {
  return (
    <div
      className="bg-card border-border flex items-start gap-3 rounded-xl border p-4 md:p-6"
      data-slot="onboarding-first-result-done"
      role="status"
    >
      <span
        aria-hidden="true"
        className="bg-primary/10 text-primary flex size-9 shrink-0 items-center justify-center rounded-full"
      >
        <CheckCircle2 className="size-5" />
      </span>
      <div className="min-w-0 space-y-1">
        <p className="text-sm font-medium">{title}</p>
        {detail ? <p className="text-sm">{detail}</p> : null}
      </div>
    </div>
  );
}
