/**
 * The emergency card as it reads on a phone (v1.49): one column of labelled
 * blocks, the items a first responder acts on first at the top.
 *
 * Shared by the owner's card page and the read-only `/e/<token>` view, so
 * the two can never word the same card differently (`emergencyCardRows`).
 * No hooks: the caller hands in its translator and locale, which keeps it a
 * server component on the public view (no app bundle, nothing to cache) and a
 * plain child on the owner's page. Every string renders as escaped React text.
 */
import type { EmergencyCardView } from "@/lib/emergency-card/card-data";
import { emergencyCardRows, type Translate } from "@/lib/emergency-card/rows";

export function EmergencyCardSheet({
  view,
  t,
  locale,
}: {
  view: EmergencyCardView;
  t: Translate;
  locale: string;
}) {
  const rows = emergencyCardRows(view, t, locale);
  return (
    <dl className="divide-border divide-y" data-slot="emergency-card-sheet">
      {rows.map((row) => (
        <div key={row.key} className="py-3" data-field={row.key}>
          <dt className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            {row.label}
          </dt>
          {row.lines.map((line, i) => (
            <dd
              key={i}
              className={
                row.emphasise
                  ? "text-foreground mt-1 text-base font-semibold break-words"
                  : "text-foreground mt-1 text-sm break-words whitespace-pre-line"
              }
            >
              {line}
            </dd>
          ))}
        </div>
      ))}
    </dl>
  );
}
