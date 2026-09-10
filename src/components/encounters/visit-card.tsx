"use client";

/**
 * One visit, as a row in the list.
 *
 * The date, the practice and the reason are what the person wrote, so all three
 * are `text-foreground`; the counts and the relative distance are meta and
 * muted. Status is carried by the SECTION rather than repeated on every card —
 * a card in the upcoming list is planned by construction, and a badge saying so
 * on every row is noise that hides the two rows where the status is a surprise.
 * A cancelled or missed visit is the exception and says so, because those are
 * the ones a person is scanning for.
 */
import {
  CalendarClock,
  FileText,
  FlaskConical,
  Stethoscope,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import type { Encounter } from "@/hooks/use-encounters";
import type { EncounterKind, EncounterStatus } from "@/generated/prisma/client";
import { encounterKindText, encounterStatusText } from "./encounter-labels";

/** The two statuses worth calling out on a row; the rest the section implies. */
function isNoteworthy(status: EncounterStatus): boolean {
  return status === "CANCELLED" || status === "NO_SHOW";
}

export function VisitCard({
  encounter,
  onOpen,
}: {
  encounter: Encounter;
  /**
   * Opens the edit sheet. Omitted when the caller may not change the visit —
   * `PATCH` and `DELETE /api/encounters/{id}` are both `("manage", "profile")`,
   * so a READ or WRITE delegate gets the card as a card and not as a button.
   * A row that reads as tappable and answers 403 is the affordance saying
   * something about the grant that is not true.
   */
  onOpen?: (encounter: Encounter) => void;
}) {
  const { t } = useTranslations();
  const format = useFormatters();

  const counts = [
    {
      icon: FileText,
      n: encounter.links?.documents.length ?? 0,
      label: t("encounters.card.documentCount"),
    },
    {
      icon: FlaskConical,
      n: encounter.links?.labResults.length ?? 0,
      label: t("encounters.card.labCount"),
    },
    {
      icon: Stethoscope,
      n: encounter.links?.conditions.length ?? 0,
      label: t("encounters.card.conditionCount"),
    },
  ].filter((entry) => entry.n > 0);

  // The practice, or the kind when there is none. A visit with neither is not
  // nameless — the kind always resolves, because it defaults to one.
  const heading =
    encounter.practitioner?.name ??
    encounterKindText(t, encounter.kind as EncounterKind);

  return (
    <Card
      data-slot="visit-card"
      data-encounter-id={encounter.id}
      className="gap-2 py-3 md:py-4"
    >
      <CardContent className="space-y-2">
        <Body onOpen={onOpen} encounter={encounter}>
          <div className="flex items-start gap-2">
            <CalendarClock
              className="text-foreground mt-0.5 size-5 shrink-0"
              aria-hidden
            />
            <div className="min-w-0 flex-1">
              <p className="text-foreground truncate text-sm font-medium">
                {heading}
              </p>
              <p className="text-muted-foreground text-xs">
                {format.dateTime(encounter.occurredAt)}
              </p>
            </div>
            <Badge variant="outline" className="shrink-0">
              {encounterKindText(t, encounter.kind as EncounterKind)}
            </Badge>
          </div>

          {encounter.reason ? (
            <p className="text-foreground line-clamp-1 text-sm">
              {encounter.reason}
            </p>
          ) : null}

          {isNoteworthy(encounter.status as EncounterStatus) ||
          counts.length ? (
            <div className="flex flex-wrap items-center gap-3">
              {isNoteworthy(encounter.status as EncounterStatus) ? (
                <span className="text-muted-foreground text-xs">
                  {encounterStatusText(t, encounter.status as EncounterStatus)}
                </span>
              ) : null}
              {counts.map(({ icon: Icon, n, label }) => (
                <span
                  key={label}
                  className="text-muted-foreground flex items-center gap-1 text-xs tabular-nums"
                  aria-label={`${n} ${label}`}
                >
                  <Icon className="size-3.5" aria-hidden />
                  {n}
                </span>
              ))}
            </div>
          ) : null}
        </Body>
      </CardContent>
    </Card>
  );
}

/**
 * The row's content, tappable or not.
 *
 * One element either way rather than two copies of the content: the read-only
 * form keeps the same spacing the button had, so a card that loses its edit
 * affordance does not also change shape.
 */
function Body({
  onOpen,
  encounter,
  children,
}: {
  onOpen?: (encounter: Encounter) => void;
  encounter: Encounter;
  children: React.ReactNode;
}) {
  if (!onOpen) return <div className="w-full space-y-2">{children}</div>;
  return (
    <button
      type="button"
      data-slot="visit-card-open"
      onClick={() => onOpen(encounter)}
      className="focus-visible:ring-ring/50 w-full space-y-2 text-left focus-visible:ring-[3px] focus-visible:outline-none"
    >
      {children}
    </button>
  );
}
