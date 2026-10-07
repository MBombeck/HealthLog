import { cn } from "@/lib/utils";

/** A trailing ellipsis, three dots or the single character. */
const TRAILING_ELLIPSIS = /(?:\.\.\.|…)\s*$/u;

/** The stagger of the three dots, one class each (no inline style). */
const DOT_DELAYS = [
  "[animation-delay:0s]",
  "[animation-delay:0.2s]",
  "[animation-delay:0.4s]",
] as const;

/**
 * Text that is still waiting on something: a trailing "..." or "…" becomes
 * three dots that fade in turn (`waiting-dot` in `globals.css`), so the line
 * reads as alive without a spinner beside it. Text without a trailing
 * ellipsis renders as it is. Under reduced motion the dots stand still.
 *
 * `textClassName` styles the words alone, never the dots: a text effect
 * clipped to the glyphs (`text-shimmer`) does not reliably reach a child
 * that animates its own opacity, so the dots keep the surrounding colour.
 *
 * The dots are ordinary full stops, so the text reads and copies as
 * "Thinking...". A surface that announces its status elsewhere hides this
 * text from assistive technology itself.
 */
export function WaitingText({
  text,
  textClassName,
}: {
  text: string;
  textClassName?: string;
}) {
  const match = TRAILING_ELLIPSIS.exec(text);
  const words = match ? text.slice(0, match.index) : text;
  return (
    <>
      <span className={textClassName}>{words}</span>
      {match ? (
        <span data-slot="waiting-dots">
          {DOT_DELAYS.map((delay) => (
            <span key={delay} className={cn("waiting-dot", delay)}>
              .
            </span>
          ))}
        </span>
      ) : null}
    </>
  );
}
