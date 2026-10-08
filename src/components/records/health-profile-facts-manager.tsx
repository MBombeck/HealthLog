"use client";

import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { toastWrittenOutcome } from "@/components/outcome/outcome-toast";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { Label } from "@/components/ui/label";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ApiError,
  apiDelete,
  apiGet,
  apiPatch,
  apiPost,
} from "@/lib/api/api-fetch";
import { isConflict } from "@/lib/api/optimistic-token";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import {
  ALCOHOL_PATTERN_VALUES,
  HEALTH_PROFILE_FACT_KINDS,
  SHIFT_SCHEDULE_VALUES,
  SMOKING_STATUS_VALUES,
  type HealthProfileFactKind,
  type HealthProfileFactValue,
} from "@/lib/validations/health-profile-facts";

interface FactDto {
  id: string;
  kind: HealthProfileFactKind;
  value: HealthProfileFactValue | null;
  unreadable: boolean;
  validFrom: string;
  validUntil: string | null;
  provenance: "USER_REPORTED" | "USER_CORRECTION";
  supersededByRevisionId: string | null;
  createdAt: string;
}

interface FactsData {
  current: Record<HealthProfileFactKind, FactDto | null>;
  history: FactDto[];
}

interface RemovedFactDto {
  id: string;
  kind: HealthProfileFactKind;
  removedAt: string;
}

const VALUES: Record<HealthProfileFactKind, readonly string[]> = {
  SMOKING_STATUS: SMOKING_STATUS_VALUES,
  ALCOHOL_PATTERN: ALCOHOL_PATTERN_VALUES,
  SHIFT_SCHEDULE: SHIFT_SCHEDULE_VALUES,
};

function isStaleFactTarget(error: unknown): boolean {
  return (
    isConflict(error) || (error instanceof ApiError && error.status === 404)
  );
}

const KIND_LABEL: Record<HealthProfileFactKind, string> = {
  SMOKING_STATUS: "records.profileFacts.smokingLabel",
  ALCOHOL_PATTERN: "records.profileFacts.alcoholLabel",
  SHIFT_SCHEDULE: "records.profileFacts.shiftLabel",
};

export function HealthProfileFactsManager() {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const queryClient = useQueryClient();
  const [drafts, setDrafts] = useState<
    Partial<Record<HealthProfileFactKind, string>>
  >({});
  // Kinds whose last save attempt failed. A per-kind flag rather than a single
  // banner, so a partial failure names which entry the user still has to redo
  // instead of hiding it behind one green toast.
  const [failedKinds, setFailedKinds] = useState<
    Partial<Record<HealthProfileFactKind, boolean>>
  >({});
  // Live copy of the draft set. State drives the controlled Selects; this ref
  // is what the one footer Save reads at click time, so a multi-field save
  // always writes the latest selections and never a value a render lagged on.
  const draftsRef = useRef<Partial<Record<HealthProfileFactKind, string>>>({});

  const editDraft = (kind: HealthProfileFactKind, value: string) => {
    draftsRef.current = { ...draftsRef.current, [kind]: value };
    setDrafts(draftsRef.current);
    // Editing a kind clears its stale failure marker; the next Save decides its
    // outcome afresh.
    setFailedKinds((old) => (old[kind] ? { ...old, [kind]: undefined } : old));
  };

  const query = useQuery({
    queryKey: queryKeys.healthProfileFacts(),
    queryFn: () => apiGet<FactsData>("/api/anamnesis/facts"),
  });

  const save = useMutation({
    mutationKey: queryKeys.healthProfileFacts(),
    // One Save for the whole tile: iterate only the dirty kinds, fire the right
    // bitemporal call per kind (PATCH a revision, POST a first value), and settle
    // them together so a single 409 cannot take the healthy writes down with it.
    mutationFn: async (
      inputs: Array<{
        kind: HealthProfileFactKind;
        value: string;
        current: FactDto | null;
      }>,
    ) => {
      const settled = await Promise.allSettled(
        inputs.map((input) =>
          input.current
            ? apiPatch<FactDto>(`/api/anamnesis/facts/${input.current.id}`, {
                value: input.value,
              })
            : apiPost<FactDto>("/api/anamnesis/facts", {
                kind: input.kind,
                value: input.value,
              }),
        ),
      );
      return inputs.map((input, index) => ({
        kind: input.kind,
        outcome: settled[index],
      }));
    },
    onSuccess: (results) => {
      const succeeded = results.filter((r) => r.outcome.status === "fulfilled");
      const failed = results.filter((r) => r.outcome.status === "rejected");

      // Clear the drafts and the failure flags only for the kinds that landed.
      // A kind that 409'd keeps its draft on screen so the user can retry it.
      const remaining = { ...draftsRef.current };
      for (const { kind } of succeeded) delete remaining[kind];
      draftsRef.current = remaining;
      setDrafts(remaining);
      setFailedKinds((current) => {
        const next = { ...current };
        for (const { kind } of succeeded) next[kind] = undefined;
        for (const { kind } of failed) next[kind] = true;
        return next;
      });

      if (succeeded.length > 0) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.healthProfileFacts(),
        });
        queryClient.invalidateQueries({
          queryKey: queryKeys.insightsAdvisor(),
        });
      } else if (
        failed.some((r) =>
          isStaleFactTarget((r.outcome as PromiseRejectedResult).reason),
        )
      ) {
        // Nothing persisted, but a stale target means our view is behind the
        // server; refetch so the next attempt revises the current revision.
        queryClient.invalidateQueries({
          queryKey: queryKeys.healthProfileFacts(),
        });
      }

      if (failed.length === 0) {
        toastWrittenOutcome("success", t("records.profileFacts.savedToast"));
      } else {
        toast.error(
          t("records.profileFacts.savePartialError", {
            kinds: failed.map((r) => t(KIND_LABEL[r.kind])).join(", "),
          }),
        );
      }
    },
  });

  const remove = useMutation({
    mutationKey: queryKeys.healthProfileFacts(),
    mutationFn: (current: FactDto) =>
      apiDelete<RemovedFactDto>(`/api/anamnesis/facts/${current.id}`),
    onSuccess: (removed) => {
      setDrafts((current) => ({ ...current, [removed.kind]: undefined }));
      queryClient.setQueryData<FactsData>(
        queryKeys.healthProfileFacts(),
        (facts) =>
          facts
            ? {
                current: {
                  ...facts.current,
                  [removed.kind]: null,
                },
                history: facts.history.map((revision) =>
                  revision.id === removed.id
                    ? { ...revision, validUntil: removed.removedAt }
                    : revision,
                ),
              }
            : facts,
      );
      toastWrittenOutcome(
        "success",
        t("records.profileFacts.removedToast", {
          kind: t(KIND_LABEL[removed.kind]),
        }),
      );
      queryClient.invalidateQueries({
        queryKey: queryKeys.healthProfileFacts(),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.insightsAdvisor(),
      });
    },
    onError: (error, current) => {
      if (isStaleFactTarget(error)) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.healthProfileFacts(),
        });
      }
      toast.error(
        t("records.profileFacts.removeError", {
          kind: t(KIND_LABEL[current.kind]),
        }),
      );
    },
  });

  if (query.isError) {
    return (
      <QueryErrorCard
        title={t("records.profileFacts.loadError")}
        onRetry={() => void query.refetch()}
      />
    );
  }

  const disabled = query.isLoading || save.isPending || remove.isPending;
  const closedHistory = (query.data?.history ?? []).filter(
    (revision) => revision.validUntil !== null,
  );

  // A kind is dirty when its draft differs from the stored value and is not the
  // empty placeholder. `isDirty` drives the render (Save enabled state); the
  // footer re-collects the same set from the ref at click time.
  const isDirty = (kind: HealthProfileFactKind, draft: string | undefined) => {
    const current = query.data?.current[kind] ?? null;
    return draft !== undefined && draft !== "" && draft !== current?.value;
  };
  const dirtyCount = HEALTH_PROFILE_FACT_KINDS.filter((kind) =>
    isDirty(kind, drafts[kind]),
  ).length;
  const collectDirtyInputs = () =>
    HEALTH_PROFILE_FACT_KINDS.flatMap((kind) => {
      const draft = draftsRef.current[kind];
      if (!isDirty(kind, draft)) return [];
      return [
        {
          kind,
          value: draft as string,
          current: query.data?.current[kind] ?? null,
        },
      ];
    });

  return (
    <div className="space-y-6" data-slot="health-profile-facts-manager">
      <div className="grid gap-4 md:grid-cols-3">
        {HEALTH_PROFILE_FACT_KINDS.map((kind) => {
          const current = query.data?.current[kind] ?? null;
          const value = drafts[kind] ?? current?.value ?? "";
          const failed = failedKinds[kind] === true;
          return (
            <div key={kind} className="space-y-2">
              <Label htmlFor={`health-profile-fact-${kind}`}>
                {t(KIND_LABEL[kind])}
              </Label>
              <Select
                value={value}
                disabled={disabled}
                onValueChange={(next) => editDraft(kind, next)}
              >
                <SelectTrigger
                  id={`health-profile-fact-${kind}`}
                  className="w-full"
                >
                  <SelectValue
                    placeholder={
                      current?.unreadable
                        ? t("records.profileFacts.unreadable")
                        : t("records.profileFacts.notRecorded")
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {VALUES[kind].map((option) => (
                    <SelectItem key={option} value={option}>
                      {t(`records.profileFacts.values.${kind}.${option}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {/* Per-entry row now carries only the quiet destructive action:
                  saving is one shared footer button (UI-STANDARDS §11), so the
                  three fields no longer each stack their own grey Save slab.
                  When a shared Save partially fails, the kind that didn't land
                  says so here rather than behind the toast. */}
              {failed || current ? (
                <div className="flex items-center justify-between gap-2 pt-1">
                  {failed ? (
                    <span
                      className="text-destructive text-xs"
                      data-slot={`health-profile-fact-error-${kind}`}
                    >
                      {t("records.profileFacts.saveKindError")}
                    </span>
                  ) : (
                    <span aria-hidden />
                  )}
                  {current ? (
                    <ConfirmButton
                      // Short label inside the row; the full phrase stays the
                      // accessible name, because "Remove" on its own is
                      // ambiguous once three of them are on screen.
                      label={t("records.profileFacts.removeShort")}
                      ariaLabel={t("records.profileFacts.remove", {
                        kind: t(KIND_LABEL[kind]),
                      })}
                      title={t("records.profileFacts.removeConfirmTitle", {
                        kind: t(KIND_LABEL[kind]),
                      })}
                      body={t("records.profileFacts.removeConfirmDescription")}
                      confirmLabel={t("records.profileFacts.remove", {
                        kind: t(KIND_LABEL[kind]),
                      })}
                      onConfirm={() => remove.mutate(current)}
                      pending={
                        remove.isPending && remove.variables?.id === current.id
                      }
                      disabled={disabled}
                      variant="ghost"
                      size="sm"
                      className="text-destructive min-h-11 sm:min-h-9"
                      icon={<Trash2 className="size-4" aria-hidden />}
                      slot={`health-profile-fact-remove-${kind}`}
                    />
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {closedHistory.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium">
            {t("records.profileFacts.historyTitle")}
          </h3>
          <ul className="divide-border divide-y text-sm">
            {closedHistory.map((revision) => (
              <li
                key={revision.id}
                className="flex flex-wrap items-center justify-between gap-2 py-2"
              >
                <span>
                  {t(KIND_LABEL[revision.kind])}:{" "}
                  {revision.unreadable
                    ? t("records.profileFacts.unreadable")
                    : revision.value
                      ? t(
                          `records.profileFacts.values.${revision.kind}.${revision.value}`,
                        )
                      : t("records.profileFacts.notRecorded")}
                </span>
                <span className="text-muted-foreground text-xs">
                  {fmt.dateTime(revision.validFrom)}
                  {revision.validUntil ? (
                    <>
                      {" "}
                      {t("records.profileFacts.to")}{" "}
                      {fmt.dateTime(revision.validUntil)}
                    </>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* One Save for the whole tile. It writes only the dirty kinds and stays
          disabled until at least one field differs from its stored value. It
          is the last thing in the card, below the history (design standards
          §12). */}
      <SettingsCardActions>
        <Button
          type="button"
          size="sm"
          className="min-h-11 sm:min-h-9"
          disabled={disabled || dirtyCount === 0}
          onClick={() => save.mutate(collectDirtyInputs())}
        >
          {save.isPending && (
            <Loader2
              className="size-4 animate-spin motion-reduce:animate-none"
              aria-hidden
            />
          )}
          {t("records.profileFacts.save")}
        </Button>
      </SettingsCardActions>
    </div>
  );
}
