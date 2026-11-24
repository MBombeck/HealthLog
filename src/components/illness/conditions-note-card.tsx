"use client";

/**
 * The chronic conditions the person wrote down in their medical history,
 * shown where the conditions themselves live.
 *
 * The written note and the chronic episodes are two records of one thing,
 * and the emergency card lists both. Showing the note here, read-only with
 * a way to where it is edited, keeps the illness page from telling half of
 * it. The note is read through the same self-context read and cache entry
 * the medical-history editor uses (`ConditionsManager`), so the two can
 * never show different text.
 *
 * The owner's own record only, and only while the Coach is on: the note's
 * editor in the medical history follows that switch, and a note that could
 * not be opened for editing would be a dead end here.
 */
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { NotebookPen } from "lucide-react";

import { TileHeader } from "@/components/insights/tile-header";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { InlineAction } from "@/components/ui/inline-action";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { useModuleEnabled } from "@/hooks/use-module-enabled";
import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import { apiGet } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

export function ConditionsNoteCard() {
  const { t } = useTranslations();
  const { inSharedRecord } = useRecordCapabilities();
  const enabled = useModuleEnabled("coach") && !inSharedRecord;
  const query = useQuery({
    queryKey: queryKeys.coachAboutMe(),
    queryFn: () => apiGet<{ conditions: string | null }>("/api/coach/about-me"),
    enabled,
  });

  if (!enabled) return null;
  if (query.isError) {
    return (
      <QueryErrorRow
        error={query.error}
        message={t("records.conditions.loadError")}
        onRetry={() => void query.refetch()}
      />
    );
  }
  const note = query.data?.conditions?.trim();
  if (!note) return null;

  return (
    <Card data-slot="illness-conditions-note">
      <CardHeader>
        <TileHeader
          icon={NotebookPen}
          title={t("records.conditions.conditionsLabel")}
        />
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm break-words whitespace-pre-line">{note}</p>
        <InlineAction size="sm" asChild>
          <Link href="/settings/anamnesis#conditions">
            {t("settings.sections.anamnesis.title")}
          </Link>
        </InlineAction>
      </CardContent>
    </Card>
  );
}
