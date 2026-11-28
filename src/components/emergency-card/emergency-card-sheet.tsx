/**
 * The emergency card as it reads on a phone (v1.49): the name as a title
 * line when recorded, then one column of labelled blocks, the items a first
 * responder acts on first at the top.
 *
 * Shared by the owner's card page and the read-only `/e/<token>` view, so
 * the two can never word the same card differently (`emergencyCardRows`).
 * No hooks: the caller hands in its translator and locale, which keeps it a
 * server component on the public view (no app bundle, nothing to cache) and a
 * plain child on the owner's page. Every string renders as escaped React text.
 *
 * On the owner's page (`targets`) every line opens the surface that owns it:
 * an allergy the medical history, a condition its illness page, a medication
 * its own page. The items not recorded yet share one row there, each name a
 * link to where it is filled in, rather than one "Not recorded" row apiece.
 * The public view gets no targets and no links, and keeps every row: a first
 * responder reads "Not recorded" against the item it answers.
 */
import Link from "next/link";
import { ChevronRight } from "lucide-react";

import type { EmergencyCardView } from "@/lib/emergency-card/card-data";
import type { EmergencyCardTargets } from "@/lib/emergency-card/edit-targets";
import {
  emergencyCardRows,
  splitCardTitle,
  type Translate,
} from "@/lib/emergency-card/rows";

export function EmergencyCardSheet({
  view,
  t,
  locale,
  targets,
}: {
  view: EmergencyCardView;
  t: Translate;
  locale: string;
  /** The owner's view: where each line is edited. */
  targets?: EmergencyCardTargets;
}) {
  // The name, when recorded, is the card's title line above the items.
  const { title, rows: all } = splitCardTitle(
    emergencyCardRows(view, t, locale, targets),
  );
  const rows = targets ? all.filter((row) => !row.empty) : all;
  const missing = targets ? all.filter((row) => row.empty) : [];
  return (
    <div data-slot="emergency-card-sheet">
      {title ? (
        <p
          className="text-foreground text-lg font-semibold break-words"
          data-field="NAME"
        >
          {title}
        </p>
      ) : null}
      <dl className="divide-border divide-y">
        {rows.map((row) => (
          <div key={row.key} className="py-3" data-field={row.key}>
            <dt className="text-muted-foreground text-xs font-medium">
              {row.label}
            </dt>
            {row.lines.map((line, i) => {
              const href = row.hrefs?.[i] ?? null;
              return (
                <dd
                  key={i}
                  className={
                    row.emphasise
                      ? "text-foreground mt-1 text-base font-semibold break-words"
                      : "text-foreground mt-1 text-sm break-words whitespace-pre-line"
                  }
                >
                  {href ? (
                    <Link
                      href={href}
                      data-slot="emergency-card-line-link"
                      className="focus-visible:ring-ring/50 flex items-center justify-between gap-2 rounded-sm underline-offset-4 hover:underline focus-visible:ring-[3px] focus-visible:outline-none pointer-coarse:min-h-11"
                    >
                      <span className="min-w-0">{line}</span>
                      <ChevronRight
                        className="text-muted-foreground size-4 shrink-0"
                        aria-hidden="true"
                      />
                    </Link>
                  ) : (
                    line
                  )}
                </dd>
              );
            })}
          </div>
        ))}
        {missing.length > 0 ? (
          <div className="py-3" data-field="MISSING">
            <dt className="text-muted-foreground text-xs font-medium">
              {t("records.emergency.notRecorded")}
            </dt>
            <dd className="text-foreground mt-1 text-sm">
              {missing.map((row, i) => {
                const href = row.hrefs?.[0] ?? null;
                return (
                  <span key={row.key}>
                    {i > 0 ? ", " : null}
                    {href ? (
                      <Link
                        href={href}
                        data-slot="emergency-card-missing-link"
                        className="focus-visible:ring-ring/50 rounded-sm underline decoration-dotted underline-offset-4 hover:decoration-solid focus-visible:ring-[3px] focus-visible:outline-none"
                      >
                        {row.label}
                      </Link>
                    ) : (
                      row.label
                    )}
                  </span>
                );
              })}
            </dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
}
