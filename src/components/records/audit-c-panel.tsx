"use client";

/**
 * v1.43 (#614) — the alcohol section of the life circumstances: AUDIT-C.
 *
 * The three items render exactly as the server delivers them
 * (`auditC.instrument`): validated wording in the account language, or the
 * WHO English original with a note when no validated translation exists.
 * This file never carries item text of its own. The result line, the cut-off
 * and its source are the server's too; nothing is scored here.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Trash2 } from "lucide-react";

import { toastWrittenOutcome } from "@/components/outcome/outcome-toast";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { apiDelete, apiGet, apiPost } from "@/lib/api/api-fetch";
import { showErrorToast } from "@/lib/errors/error-toast";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import type { HealthProfileFactsPayload } from "@/lib/profile/health-facts";
import type { LifeCircumstancesDto } from "@/lib/profile/life-circumstances";
import { queryKeys } from "@/lib/query-keys";

type AuditC = LifeCircumstancesDto["auditC"];

export function AuditCPanel({
  data,
  onChanged,
}: {
  data: AuditC;
  onChanged: () => void;
}) {
  const { t, locale } = useTranslations();
  const fmt = useFormatters();
  const [open, setOpen] = useState(false);
  const [answers, setAnswers] = useState<Array<number | null>>([
    null,
    null,
    null,
  ]);
  const { instrument, latest } = data;

  const submit = useMutation({
    mutationKey: queryKeys.lifeCircumstances(),
    mutationFn: (items: number[]) =>
      apiPost("/api/anamnesis/audit-c", {
        items,
        // The language of the wording actually answered; the cut-off follows it.
        locale: instrument.locale,
        source: "WEB",
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }),
    onSuccess: () => {
      toastWrittenOutcome("success", t("records.life.auditC.savedToast"));
      setOpen(false);
      setAnswers([null, null, null]);
      onChanged();
    },
    onError: (error) =>
      showErrorToast(t("records.life.auditC.saveError"), { cause: error }),
  });

  const remove = useMutation({
    mutationKey: queryKeys.lifeCircumstances(),
    mutationFn: (id: string) => apiDelete(`/api/anamnesis/audit-c/${id}`),
    onSuccess: () => {
      toastWrittenOutcome("success", t("records.life.auditC.removedToast"));
      onChanged();
    },
    onError: (error) =>
      showErrorToast(t("records.life.auditC.removeError"), { cause: error }),
  });

  const complete = answers.every((answer) => answer !== null);

  // The one-word alcohol pattern asked before AUDIT-C. It still lives in the
  // record, so it is shown here, where alcohol now lives, with a way out.
  // The Coach stops reading it once an AUDIT-C entry exists.
  const queryClient = useQueryClient();
  const facts = useQuery({
    queryKey: queryKeys.healthProfileFacts(),
    queryFn: () => apiGet<HealthProfileFactsPayload>("/api/anamnesis/facts"),
  });
  const legacy = facts.data?.current.ALCOHOL_PATTERN ?? null;
  const removeLegacy = useMutation({
    mutationKey: queryKeys.healthProfileFacts(),
    mutationFn: (id: string) => apiDelete(`/api/anamnesis/facts/${id}`),
    onSuccess: () => {
      toastWrittenOutcome(
        "success",
        t("records.life.auditC.legacyRemovedToast"),
      );
      void queryClient.invalidateQueries({
        queryKey: queryKeys.healthProfileFacts(),
      });
      onChanged();
    },
    onError: (error) =>
      showErrorToast(t("records.life.auditC.legacyRemoveError"), {
        cause: error,
      }),
  });

  return (
    <div className="space-y-4" data-slot="audit-c-panel">
      <p className="text-sm">{t("records.life.auditC.intro")}</p>

      {latest ? (
        <div className="space-y-1" data-slot="audit-c-latest">
          <p className="text-sm font-medium">
            {t("records.life.auditC.result", { score: latest.totalScore })}
            <span className="text-muted-foreground text-xs font-normal">
              {" "}
              {fmt.date(new Date(latest.takenAt))}
            </span>
          </p>
          <p className="text-sm">
            {latest.cutoff === null
              ? t("records.life.auditC.noCutoff")
              : t(
                  latest.aboveCutoff
                    ? "records.life.auditC.above"
                    : "records.life.auditC.below",
                  { cutoff: latest.cutoff.value },
                )}
          </p>
          {latest.cutoff ? (
            <p className="text-muted-foreground text-xs">
              <a
                href={latest.cutoff.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-2"
              >
                {t("records.life.auditC.source", {
                  source: latest.cutoff.sourceLabel,
                })}
              </a>
            </p>
          ) : null}
        </div>
      ) : null}

      {data.history.length > 0 ? (
        <div className="space-y-1">
          <h4 className="text-muted-foreground text-xs font-medium">
            {t("records.life.auditC.history")}
          </h4>
          <ul className="divide-border divide-y text-sm">
            {data.history.map((entry) => (
              <li
                key={entry.id}
                className="flex items-center justify-between gap-2 py-1.5"
              >
                <span>
                  {t("records.life.auditC.historyEntry", {
                    date: fmt.date(new Date(entry.takenAt)),
                    score: entry.totalScore,
                  })}
                </span>
                <ConfirmButton
                  label=""
                  ariaLabel={t("records.life.auditC.remove")}
                  title={t("records.life.auditC.removeConfirmTitle")}
                  body={t("records.life.auditC.removeConfirmBody")}
                  confirmLabel={t("records.life.auditC.remove")}
                  onConfirm={() => remove.mutate(entry.id)}
                  pending={remove.isPending && remove.variables === entry.id}
                  disabled={remove.isPending}
                  variant="ghost"
                  size="icon"
                  className="text-destructive size-11 shrink-0 sm:size-9"
                  icon={<Trash2 className="size-4" aria-hidden />}
                  slot={`audit-c-remove-${entry.id}`}
                  destructive
                />
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {legacy?.value ? (
        <div
          className="flex items-start justify-between gap-2"
          data-slot="audit-c-legacy-pattern"
        >
          <div className="min-w-0 flex-1 space-y-1">
            <p className="text-sm">
              {t("records.life.auditC.legacyLabel", {
                value: t(
                  `records.profileFacts.values.ALCOHOL_PATTERN.${legacy.value}`,
                ),
              })}
            </p>
            <p className="text-muted-foreground text-xs">
              {t("records.life.auditC.legacyHint")}
            </p>
          </div>
          <ConfirmButton
            label=""
            ariaLabel={t("records.life.auditC.legacyRemove")}
            title={t("records.life.auditC.legacyRemoveConfirmTitle")}
            body={t("records.life.auditC.legacyRemoveConfirmBody")}
            confirmLabel={t("records.life.auditC.legacyRemove")}
            onConfirm={() => removeLegacy.mutate(legacy.id)}
            pending={removeLegacy.isPending}
            disabled={removeLegacy.isPending}
            variant="ghost"
            size="icon"
            className="text-destructive size-11 shrink-0 sm:size-9"
            icon={<Trash2 className="size-4" aria-hidden />}
            slot="audit-c-legacy-remove"
            destructive
          />
        </div>
      ) : null}

      {data.offerDue ? (
        <p className="text-muted-foreground text-xs">
          {t("records.life.auditC.offerDue")}
        </p>
      ) : null}
      <SettingsCardActions>
        <Button
          type="button"
          size="sm"
          variant={data.offerDue ? "default" : "outline"}
          onClick={() => setOpen(true)}
          data-slot="audit-c-start"
        >
          {latest
            ? t("records.life.auditC.again")
            : t("records.life.auditC.start")}
        </Button>
      </SettingsCardActions>

      <ResponsiveSheet
        open={open}
        onOpenChange={setOpen}
        title={t("records.life.sections.alcohol.title")}
        description={t("records.life.auditC.intro")}
        footer={
          <Button
            type="button"
            size="sm"
            className="min-h-11 sm:min-h-9"
            disabled={!complete || submit.isPending}
            onClick={() => submit.mutate(answers as number[])}
            data-slot="audit-c-submit"
          >
            {submit.isPending && (
              <Loader2
                className="size-4 animate-spin motion-reduce:animate-none"
                aria-hidden
              />
            )}
            {t("records.life.auditC.submit")}
          </Button>
        }
      >
        <div className="space-y-6" lang={instrument.locale}>
          {!instrument.validatedLocale ? (
            <p className="text-sm" lang={locale}>
              {t("records.life.auditC.notValidated")}
            </p>
          ) : null}
          <p className="text-sm" lang={locale}>
            {instrument.standardDrink}
          </p>
          {instrument.items.map((item, index) => (
            <fieldset key={index} className="space-y-2">
              <legend className="text-sm font-medium">
                {index + 1}. {item.stem}
              </legend>
              <div className="space-y-1">
                {item.options.map((option) => (
                  <label
                    key={option.value}
                    className="flex min-h-11 items-center gap-2 text-sm sm:min-h-9"
                  >
                    <input
                      type="radio"
                      name={`audit-c-${index}`}
                      value={option.value}
                      checked={answers[index] === option.value}
                      onChange={() =>
                        setAnswers((old) =>
                          old.map((value, i) =>
                            i === index ? option.value : value,
                          ),
                        )
                      }
                      className="accent-primary size-4"
                    />
                    {option.label}
                  </label>
                ))}
              </div>
            </fieldset>
          ))}
          <p className="text-muted-foreground text-xs" lang="en">
            {instrument.attribution}
          </p>
        </div>
      </ResponsiveSheet>
    </div>
  );
}
