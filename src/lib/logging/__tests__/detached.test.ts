/**
 * Detached work keeps its hands off the action of the event it was started
 * from, and keeps everything else it may do there.
 */
import { describe, expect, it } from "vitest";

import { withBackgroundEvent } from "../background";
import { settleBackgroundTasks } from "../background-tasks";
import { annotate, eventStorage, getEvent } from "../context";
import { runDetached } from "../detached";
import { WideEventBuilder } from "../event-builder";
import { fireAndForget } from "../fire-and-forget";

describe("runDetached", () => {
  it("drops the detached work's action for the parent event and keeps its meta", async () => {
    const event = new WideEventBuilder();
    await eventStorage.run(event, async () => {
      annotate({ action: { name: "measurement.create" } });
      await runDetached(async () => {
        annotate({
          action: { name: "insights.status.invalidate.skipped" },
          meta: { reason: "no_provider" },
        });
        // The request's own event is still the one it reads.
        expect(getEvent()).toBe(event);
      });
      expect(event.toJSON().action?.name).toBe("measurement.create");
      // Back in the request, the request names its action as before.
      annotate({ action: { name: "measurement.create.done" } });
    });
    expect(event.toJSON().action?.name).toBe("measurement.create.done");
    expect(event.toJSON().meta?.reason).toBe("no_provider");
  });

  it("leaves an event the detached work opens for itself its own action", async () => {
    const event = new WideEventBuilder();
    let inner: string | undefined;
    await eventStorage.run(event, async () => {
      annotate({ action: { name: "measurement.create" } });
      await runDetached(() =>
        withBackgroundEvent("test.inner", async (evt) => {
          annotate({ action: { name: "test.inner.ran" } });
          inner = evt.toJSON().action?.name;
        }),
      );
    });
    expect(inner).toBe("test.inner.ran");
    expect(event.toJSON().action?.name).toBe("measurement.create");
  });

  it("starts the work synchronously and turns a synchronous throw into a rejection", async () => {
    let started = false;
    const event = new WideEventBuilder();
    await eventStorage.run(event, async () => {
      const pending = runDetached(async () => {
        started = true;
      });
      expect(started).toBe(true);
      await pending;
      await expect(
        runDetached(() => {
          throw new Error("sync");
        }),
      ).rejects.toThrow("sync");
    });
  });

  it("detaches what fireAndForget starts", async () => {
    const event = new WideEventBuilder();
    await eventStorage.run(event, async () => {
      annotate({ action: { name: "labs.create" } });
      fireAndForget(
        async () => {
          annotate({ action: { name: "reminder.satisfy.enqueue" } });
        },
        { action: "reminder.satisfy.enqueue" },
      );
      await settleBackgroundTasks();
    });
    expect(event.toJSON().action?.name).toBe("labs.create");
  });
});
