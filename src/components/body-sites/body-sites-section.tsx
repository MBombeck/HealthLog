"use client";

/**
 * The body-site view — the fourth tab of the checkups page (v1.39.2,
 * Discussion #1025).
 *
 * "What was done on my left knee, and what is wrong with it?" Pick a site and
 * see the procedures and conditions filed there, each with the documents, lab
 * results and visits linked to it. A site is the person's own words on a
 * procedure or a condition; nothing here is a new record type or a tag, so
 * there is nothing to keep in step: the rows are the visits and conditions the
 * other pages already show.
 *
 * The grouping and the matching run on the server. Body sites are encrypted at
 * rest, so the server decrypts the record's own sites and folds them; this view
 * sends the choice and renders the answer.
 *
 * For a delegate, what the grant does not cover is not shown and not guessed
 * at. Without the illness section there is no condition list at all (the
 * server does not read it, and says so with `conditions: null`). A link into a
 * section the grant does not cover arrives with no label, and renders as a
 * placeholder naming only its kind: the delegate learns that something is
 * filed, which the visit already tells them, and never what.
 */
import {
  CalendarClock,
  FileText,
  FlaskConical,
  PersonStanding,
  Stethoscope,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { SectionHeading } from "@/components/ui/section-heading";
import { Skeleton } from "@/components/ui/skeleton";
import { useBodySites, type BodySiteSide } from "@/hooks/use-body-sites";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import type { BodySiteConditionDTO, BodySiteDTO } from "@/lib/body-sites/dto";
import type { EncounterDTO, EncounterLinkDTO } from "@/lib/encounters/dto";
import type { EncounterKind } from "@/generated/prisma/client";
import {
  bodySiteText,
  encounterKindText,
  lateralityText,
} from "@/components/encounters/encounter-labels";

type Translate = (key: string, values?: Record<string, string>) => string;

export function BodySitesSection({
  enabled = true,
  initialSite = null,
  initialSide = null,
}: {
  enabled?: boolean;
  /** A site to open on, from a `?site=` link (a condition's page links here). */
  initialSite?: string | null;
  initialSide?: BodySiteSide;
}) {
  const { t } = useTranslations();
  const [site, setSite] = useState<string | null>(initialSite);
  const [side, setSide] = useState<BodySiteSide>(
    initialSite ? initialSide : null,
  );
  const list = useBodySites(enabled, { site, laterality: side });

  const sites = list.data?.sites ?? [];
  const selection = list.data?.selection;
  // The site as the server spells it, once the answer is in; the chip the
  // person tapped until then.
  const picked = site
    ? (sites.find((entry) => fold(entry.bodySite) === fold(site)) ?? null)
    : null;

  const pickSite = (entry: BodySiteDTO | null) => {
    setSite(entry?.bodySite ?? null);
    setSide(null);
  };

  return (
    <section aria-labelledby="body-sites-title" className="space-y-4">
      <PageHeader
        titleId="body-sites-title"
        title={t("bodySites.title")}
        description={t("bodySites.description")}
      />

      {list.isError ? (
        <QueryErrorCard
          title={t("bodySites.loadError")}
          onRetry={() => void list.refetch()}
        />
      ) : list.isPending ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton key={index} className="h-20 w-full rounded-xl" />
          ))}
        </div>
      ) : sites.length === 0 ? (
        <EmptyState
          icon={<PersonStanding className="size-6" aria-hidden />}
          title={t("bodySites.emptyTitle")}
          description={t("bodySites.emptyDescription")}
        />
      ) : (
        <div className="space-y-6">
          <div className="space-y-3" data-slot="body-sites-filter">
            <div
              role="group"
              aria-label={t("bodySites.sitesLabel")}
              className="flex flex-wrap gap-2"
            >
              {sites.map((entry) => {
                const on = picked?.bodySite === entry.bodySite;
                return (
                  <Button
                    key={entry.bodySite}
                    type="button"
                    size="sm"
                    variant={on ? "secondary" : "outline"}
                    aria-pressed={on}
                    data-slot="body-site-chip"
                    className="min-h-11 rounded-full sm:min-h-9"
                    onClick={() => pickSite(on ? null : entry)}
                  >
                    {entry.bodySite}
                    <span className="text-muted-foreground tabular-nums">
                      {entry.procedures + entry.conditions}
                    </span>
                  </Button>
                );
              })}
            </div>

            {picked && picked.sides.some((s) => s.laterality !== null) ? (
              <div
                role="group"
                aria-label={t("bodySites.sidesLabel")}
                className="flex flex-wrap gap-2"
              >
                <Button
                  type="button"
                  size="sm"
                  variant={side === null ? "secondary" : "outline"}
                  aria-pressed={side === null}
                  data-slot="body-site-side"
                  className="min-h-11 rounded-full sm:min-h-9"
                  onClick={() => setSide(null)}
                >
                  {t("bodySites.allSides")}
                </Button>
                {picked.sides
                  .filter((entry) => entry.laterality !== null)
                  .map((entry) => {
                    const value = entry.laterality as Exclude<
                      BodySiteSide,
                      null
                    >;
                    const on = side === value;
                    return (
                      <Button
                        key={value}
                        type="button"
                        size="sm"
                        variant={on ? "secondary" : "outline"}
                        aria-pressed={on}
                        data-slot="body-site-side"
                        className="min-h-11 rounded-full sm:min-h-9"
                        onClick={() => setSide(on ? null : value)}
                      >
                        {lateralityText(t, value)}
                      </Button>
                    );
                  })}
              </div>
            ) : null}
          </div>

          {!site ? (
            <p className="text-muted-foreground text-sm">
              {t("bodySites.pickPrompt")}
            </p>
          ) : !selection || list.isPlaceholderData ? (
            <Skeleton className="h-32 w-full rounded-xl" />
          ) : (
            <Selection
              t={t}
              visits={selection.visits}
              conditions={selection.conditions}
            />
          )}
        </div>
      )}
    </section>
  );
}

function fold(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function Selection({
  t,
  visits,
  conditions,
}: {
  t: Translate;
  visits: EncounterDTO[];
  conditions: BodySiteConditionDTO[] | null;
}) {
  if (visits.length === 0 && (conditions === null || conditions.length === 0)) {
    return (
      <EmptyState
        icon={<PersonStanding className="size-6" aria-hidden />}
        title={t("bodySites.noMatchTitle")}
      />
    );
  }
  return (
    <div className="space-y-6" data-slot="body-site-selection">
      {visits.length > 0 ? (
        <div className="space-y-3">
          <SectionHeading
            icon={CalendarClock}
            title={t("bodySites.visitsTitle")}
          />
          <div className="space-y-2" data-slot="body-site-visits">
            {visits.map((visit) => (
              <VisitRow key={visit.id} t={t} visit={visit} />
            ))}
          </div>
        </div>
      ) : null}
      {conditions && conditions.length > 0 ? (
        <div className="space-y-3">
          <SectionHeading
            icon={Stethoscope}
            title={t("bodySites.conditionsTitle")}
          />
          <div className="space-y-2" data-slot="body-site-conditions">
            {conditions.map((condition) => (
              <ConditionRow key={condition.id} t={t} condition={condition} />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function VisitRow({ t, visit }: { t: Translate; visit: EncounterDTO }) {
  const format = useFormatters();
  const kind = encounterKindText(t, visit.kind as EncounterKind);
  // A procedure leads with what was done, like the visit card does.
  const heading = visit.reason ?? visit.practitioner?.name ?? kind;
  const site = bodySiteText(t, visit.bodySite, visit.laterality);
  return (
    <Card
      className="gap-2 py-3 md:py-4"
      data-slot="body-site-visit"
      data-encounter-id={visit.id}
    >
      <CardContent className="space-y-2">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <p className="text-foreground text-sm font-medium">{heading}</p>
            <p className="text-muted-foreground text-xs">
              {format.dateTime(visit.occurredAt)}
            </p>
          </div>
          <Badge variant="outline" className="shrink-0">
            {kind}
          </Badge>
        </div>
        {site ? <p className="text-foreground text-sm">{site}</p> : null}
        <LinkedList
          t={t}
          families={[
            {
              key: "documents",
              icon: FileText,
              items: visit.links?.documents ?? [],
              hidden: t("bodySites.hiddenDocument"),
              href: (id) => `/documents?doc=${encodeURIComponent(id)}`,
            },
            {
              key: "labResults",
              icon: FlaskConical,
              items: visit.links?.labResults ?? [],
              hidden: t("bodySites.hiddenLabResult"),
            },
            {
              key: "conditions",
              icon: Stethoscope,
              items: visit.links?.conditions ?? [],
              hidden: t("bodySites.hiddenCondition"),
              href: (id) => `/illness/${encodeURIComponent(id)}`,
            },
          ]}
        />
      </CardContent>
    </Card>
  );
}

function ConditionRow({
  t,
  condition,
}: {
  t: Translate;
  condition: BodySiteConditionDTO;
}) {
  const format = useFormatters();
  const site = bodySiteText(t, condition.bodySite, condition.laterality);
  return (
    <Card
      className="gap-2 py-3 md:py-4"
      data-slot="body-site-condition"
      data-episode-id={condition.id}
    >
      <CardContent className="space-y-2">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <Link
              href={`/illness/${encodeURIComponent(condition.id)}`}
              className="text-foreground text-sm font-medium underline-offset-4 hover:underline"
            >
              {condition.label}
            </Link>
            <p className="text-muted-foreground text-xs">
              {condition.resolvedAt
                ? t("bodySites.conditionDates", {
                    onset: format.date(condition.onsetAt),
                    resolved: format.date(condition.resolvedAt),
                  })
                : t("bodySites.conditionSince", {
                    onset: format.date(condition.onsetAt),
                  })}
            </p>
          </div>
          <Badge variant="outline" className="shrink-0">
            {t(`illness.type.${condition.type}`)}
          </Badge>
        </div>
        {site ? <p className="text-foreground text-sm">{site}</p> : null}
        <LinkedList
          t={t}
          families={[
            {
              key: "documents",
              icon: FileText,
              items: condition.links.documents,
              hidden: t("bodySites.hiddenDocument"),
              href: (id) => `/documents?doc=${encodeURIComponent(id)}`,
            },
            {
              key: "visits",
              icon: CalendarClock,
              items: condition.links.visits,
              hidden: t("bodySites.hiddenVisit"),
              // A visit's label is its kind constant; the reader names it.
              label: (item) =>
                encounterKindText(t, item.label as EncounterKind),
            },
          ]}
        />
      </CardContent>
    </Card>
  );
}

interface LinkFamily {
  key: string;
  icon: typeof FileText;
  items: EncounterLinkDTO[];
  /** What a withheld entry says: its kind, nothing more. */
  hidden: string;
  href?: (id: string) => string;
  label?: (item: EncounterLinkDTO) => string;
}

/**
 * What is linked to one row, one line per entry.
 *
 * A withheld entry keeps its line and says only what kind of thing it is, in
 * muted meta type: the fact that something is filed is visible to the caller
 * already, the name is not theirs to read. It is never a link, since the page
 * behind it would refuse them anyway.
 */
function LinkedList({ t, families }: { t: Translate; families: LinkFamily[] }) {
  const format = useFormatters();
  const rows = families.flatMap((family) =>
    family.items.map((item) => ({ family, item })),
  );
  if (rows.length === 0) return null;
  return (
    <ul
      className="space-y-1 border-t pt-2"
      aria-label={t("bodySites.linkedLabel")}
      data-slot="body-site-links"
    >
      {rows.map(({ family, item }) => {
        const Icon = family.icon;
        if (item.redacted) {
          return (
            <li
              key={`${family.key}-${item.id}`}
              className="text-muted-foreground flex items-center gap-2 text-xs"
              data-slot="body-site-link-hidden"
            >
              <Icon className="size-3.5 shrink-0" aria-hidden />
              {family.hidden}
            </li>
          );
        }
        const text = family.label ? family.label(item) : (item.label ?? "");
        return (
          <li
            key={`${family.key}-${item.id}`}
            className="flex items-center gap-2 text-sm"
            data-slot="body-site-link"
          >
            <Icon
              className="text-muted-foreground size-3.5 shrink-0"
              aria-hidden
            />
            {family.href ? (
              <Link
                href={family.href(item.id)}
                className="text-foreground min-w-0 truncate underline-offset-4 hover:underline"
              >
                {text}
              </Link>
            ) : (
              <span className="text-foreground min-w-0 truncate">{text}</span>
            )}
            {item.date ? (
              <span className="text-muted-foreground shrink-0 text-xs">
                {format.date(item.date)}
              </span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
