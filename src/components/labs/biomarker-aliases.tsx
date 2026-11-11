"use client";

/**
 * v1.43 — the other spellings a marker answers to.
 *
 * Shown as chips on the marker; with the labs manage right they can be added
 * and removed. Every change sends the whole set (`PUT /api/biomarkers/{id}`
 * with `aliases`), which is how the server reads it. A spelling another marker
 * already answers to is refused with `labs.biomarker.alias.taken`; the
 * sentence names the spelling so the person knows which one to drop.
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TagChip } from "@/components/ui/tag-chip";
import { ApiError, apiPut } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

import type { BiomarkerDto } from "./types";

/** Longest alias the server stores. */
const ALIAS_MAX = 120;

export function BiomarkerAliases({
  marker,
  canEdit,
}: {
  marker: Pick<BiomarkerDto, "id" | "name" | "aliases">;
  canEdit: boolean;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const aliases = marker.aliases ?? [];

  const save = useMutation({
    mutationFn: (next: string[]) =>
      apiPut<BiomarkerDto>(`/api/biomarkers/${marker.id}`, { aliases: next }),
    onSuccess: () => {
      setError(null);
      setDraft("");
      queryClient.invalidateQueries({
        queryKey: queryKeys.biomarkerDetail(marker.id),
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.biomarkers() });
    },
    onError: (err) => {
      const alias =
        err instanceof ApiError &&
        err.meta?.errorCode === "labs.biomarker.alias.taken" &&
        typeof err.meta.alias === "string"
          ? err.meta.alias
          : null;
      setError(
        alias
          ? t("labs.aliases.taken", { alias })
          : t("labs.aliases.saveError"),
      );
    },
  });

  if (aliases.length === 0 && !canEdit) return null;

  const add = () => {
    const name = draft.trim();
    if (!name) return;
    if (aliases.some((a) => a.toLowerCase() === name.toLowerCase())) {
      setDraft("");
      return;
    }
    save.mutate([...aliases, name]);
  };

  return (
    <div className="space-y-2" data-slot="biomarker-aliases">
      <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
        {t("labs.aliases.title")}
      </p>
      {aliases.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {aliases.map((alias) => (
            <li key={alias}>
              <TagChip className="inline-flex items-center gap-1">
                {alias}
                {canEdit ? (
                  <button
                    type="button"
                    className="hover:text-foreground text-muted-foreground focus-visible:ring-ring/50 relative -my-1 -me-1 inline-flex size-6 items-center justify-center rounded-full after:absolute after:-inset-2.5 focus-visible:ring-[3px] focus-visible:outline-none"
                    onClick={() =>
                      save.mutate(aliases.filter((a) => a !== alias))
                    }
                    disabled={save.isPending}
                    aria-label={t("labs.aliases.remove", { alias })}
                  >
                    <X className="size-3" aria-hidden />
                  </button>
                ) : null}
              </TagChip>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground text-xs">
          {t("labs.aliases.empty", { name: marker.name })}
        </p>
      )}
      {canEdit ? (
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            add();
          }}
        >
          <Input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            maxLength={ALIAS_MAX}
            placeholder={t("labs.aliases.placeholder")}
            aria-label={t("labs.aliases.addLabel")}
            className="min-w-0 flex-1"
          />
          <Button
            type="submit"
            variant="outline"
            size="sm"
            className="min-h-11 shrink-0 sm:min-h-9"
            disabled={save.isPending || draft.trim() === ""}
          >
            {save.isPending ? (
              <Loader2
                className="size-4 animate-spin motion-reduce:animate-none"
                aria-hidden
              />
            ) : (
              <Plus className="size-4" aria-hidden />
            )}
            {t("labs.aliases.add")}
          </Button>
        </form>
      ) : null}
      {error ? (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      ) : null}
    </div>
  );
}
