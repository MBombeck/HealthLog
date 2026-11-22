/**
 * The one priority rule of the toast stack: a toast with something to press
 * (Undo, Edit, Retry) is never covered by one that only informs.
 *
 * The app has one Sonner stack, and Sonner puts the newest toast in front and
 * folds the older ones behind it. A save answers with "Saved | Edit | Undo";
 * the same save can unlock achievements a moment later, and those arrived in
 * front of it, so on a phone the Undo sat under four celebration toasts and
 * expired unreachable. Exactly where an undo matters most: the first entry
 * of a kind, where a slip is likeliest.
 *
 * So a toast that is only informational and is raised without the person
 * asking for it (a background notifier: achievements and the like) goes
 * through `showInformationalToast`. While an action toast is open it waits,
 * in order, and shows once the action toast has gone (pressed, dismissed or
 * timed out). A toast the person's own action raises, and every error, shows
 * at once as before: it answers what they just did.
 */
import { toast, type ToastT, type ToastToDismiss } from "sonner";

const POLL_MS = 400;

/** Whether an open toast offers something to press. */
export function isActionToast(entry: ToastT | ToastToDismiss): boolean {
  if ("dismiss" in entry && entry.dismiss === true) return false;
  const shown = entry as ToastT;
  return shown.action != null || shown.cancel != null;
}

export function hasOpenActionToast(): boolean {
  return toast.getToasts().some(isActionToast);
}

const waiting: Array<() => void> = [];
let timer: ReturnType<typeof setInterval> | null = null;

function flush(): void {
  if (hasOpenActionToast()) return;
  if (timer !== null) clearInterval(timer);
  timer = null;
  for (const show of waiting.splice(0)) show();
}

/**
 * Show an informational toast now, or as soon as no action toast is open.
 * Queued toasts keep their order, and a new one never jumps the queue.
 */
export function showInformationalToast(show: () => void): void {
  if (waiting.length === 0 && !hasOpenActionToast()) {
    show();
    return;
  }
  waiting.push(show);
  if (timer === null) timer = setInterval(flush, POLL_MS);
}
