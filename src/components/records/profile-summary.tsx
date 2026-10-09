"use client";

import { useQuery } from "@tanstack/react-query";

import { PageHeader } from "@/components/ui/page-header";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { apiGet } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import type { ProfileSummaryPayload } from "@/lib/records/profile-summary";

function profileFactLabel(label: string, t: (key: string) => string): string {
  const keys: Record<string, string> = {
    SMOKING_STATUS: "records.profileFacts.smokingLabel",
    ALCOHOL_PATTERN: "records.profileFacts.alcoholLabel",
    SHIFT_SCHEDULE: "records.profileFacts.shiftLabel",
  };
  return keys[label] ? t(keys[label]) : label;
}

function profileFactValue(
  label: string,
  value: string,
  t: (key: string) => string,
): string {
  const supported = new Set([
    "SMOKING_STATUS",
    "ALCOHOL_PATTERN",
    "SHIFT_SCHEDULE",
  ]);
  return supported.has(label)
    ? t(`records.profileFacts.values.${label}.${value}`)
    : value;
}

/** Bounded profile facts, intentionally free of mutation controls. */
export function ProfileSummary({
  summary,
}: {
  summary: ProfileSummaryPayload;
}) {
  const { t } = useTranslations();

  return (
    <div className="space-y-4" data-slot="profile-summary">
      <Card>
        <CardHeader>
          <CardTitle>{t("records.allergies.cardTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          {summary.allergies.length ? (
            <ul className="space-y-2" data-slot="profile-summary-allergies">
              {summary.allergies.map((allergy) => (
                <li key={`${allergy.substance}-${allergy.category}`}>
                  <span className="font-medium">{allergy.substance}</span>{" "}
                  <span className="text-muted-foreground text-sm">
                    {t(`records.allergies.category.${allergy.category}`)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground text-sm">
              {t("records.allergies.emptyTitle")}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("records.family.cardTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          {summary.familyHistory.length ? (
            <ul
              className="space-y-2"
              data-slot="profile-summary-family-history"
            >
              {summary.familyHistory.map((entry) => (
                <li key={`${entry.condition}-${entry.relationship}`}>
                  <span className="font-medium">{entry.condition}</span>{" "}
                  <span className="text-muted-foreground text-sm">
                    {t(`records.family.relationship.${entry.relationship}`)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground text-sm">
              {t("records.family.emptyTitle")}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("records.profileFacts.cardTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          {summary.facts.length ? (
            <dl className="space-y-2" data-slot="profile-summary-facts">
              {summary.facts.map((fact) => (
                <div key={fact.label} className="flex justify-between gap-4">
                  <dt>{profileFactLabel(fact.label, t)}</dt>
                  <dd className="text-muted-foreground text-right">
                    {profileFactValue(fact.label, fact.value, t)}
                  </dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="text-muted-foreground text-sm">
              {t("records.profileFacts.notRecorded")}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export function ProfileSummaryPage() {
  const { t } = useTranslations();
  const summary = useQuery({
    queryKey: queryKeys.profileSummary(),
    queryFn: () => apiGet<ProfileSummaryPayload>("/api/profile/summary"),
  });

  return (
    // The shell owns the page frame (gutter, width, top space) and the
    // <main> landmark; this page only sets its rhythm.
    <div className="space-y-6">
      <PageHeader title={t("settings.sections.anamnesis.title")} />
      {summary.isPending ? (
        <p className="text-muted-foreground text-sm" aria-live="polite">
          {t("common.loading")}
        </p>
      ) : null}
      {summary.isError ? (
        <QueryErrorCard onRetry={() => void summary.refetch()} />
      ) : null}
      {summary.data ? <ProfileSummary summary={summary.data} /> : null}
    </div>
  );
}
