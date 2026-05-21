import { WideEventBuilder } from "./event-builder";
import { eventStorage } from "./context";
import { emitIfSampled } from "./transports";

/**
 * Hintergrundaufgabe mit Wide-Event-Logging ausfuehren.
 *
 * Beispiel:
 *   await withBackgroundEvent("scheduler.tick", async (evt) => {
 *     const results = await sendDailyReminders(currentTime);
 *     evt.setBackground({ task_name: "scheduler.tick", result: results });
 *   });
 */
export async function withBackgroundEvent<T>(
  taskName: string,
  fn: (evt: WideEventBuilder) => Promise<T>,
): Promise<T> {
  const evt = new WideEventBuilder("background");
  evt.setBackground({ task_name: taskName });

  return eventStorage.run(evt, async () => {
    try {
      const result = await fn(evt);
      evt.finish();
      emitIfSampled(evt.toJSON());
      return result;
    } catch (error) {
      evt.setError(error);
      evt.finish();
      emitIfSampled(evt.toJSON());
      throw error;
    }
  });
}

