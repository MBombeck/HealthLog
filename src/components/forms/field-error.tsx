import type { ReactNode } from "react";

/**
 * The error slot that belongs to one input.
 *
 * Every form that writes the profile shows a refused field the same
 * way, or the same rejection reads differently depending on where the
 * person happened to be standing. This is that one way: a destructive
 * sentence directly under the control, carrying an id the control
 * points `aria-describedby` at, so the reason is announced with the
 * field rather than only painted next to it.
 *
 * `role="alert"` is deliberate. The sentence appears in response to a
 * save the person just asked for, and a person who has already moved
 * focus past the field would otherwise never learn the value did not
 * land.
 */
export function FieldError({
  id,
  message,
}: {
  /** Conventionally `<control id>-error`. */
  id: string;
  message?: ReactNode;
}) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="text-destructive text-sm">
      {message}
    </p>
  );
}
