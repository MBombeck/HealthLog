/**
 * A name shown in its short form where the slot has one line, with the full
 * name for a screen reader (`metricName` gives both). The tooltip is the
 * caller's: put `title={full}` on the element that holds this. When there is
 * no short form the full name renders as plain text.
 *
 * RSC-safe: no hooks.
 */
export function ShortName({ short, full }: { short: string; full: string }) {
  if (short === full) return <>{full}</>;
  return (
    <>
      <span aria-hidden="true">{short}</span>
      <span className="sr-only">{full}</span>
    </>
  );
}
