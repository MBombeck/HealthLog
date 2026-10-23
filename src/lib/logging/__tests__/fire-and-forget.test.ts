import { afterEach, describe, expect, it, vi } from "vitest";
import { fireAndForget } from "../fire-and-forget";
import { eventStorage } from "../context";
import { WideEventBuilder } from "../event-builder";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fireAndForget", () => {
  it("does not throw and does not reject when the promise resolves", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fireAndForget(() => Promise.resolve("ok"), { action: "test.noop.run" });
    await flush();
    expect(warn).not.toHaveBeenCalled();
  });

  it("annotates the current wide event with the redacted error breadcrumb", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const builder = new WideEventBuilder();

    await eventStorage.run(builder, async () => {
      fireAndForget(() => Promise.reject(new Error("boom")), {
        action: "reminder.satisfy.enqueue",
        meta: { userScope: "u_1" },
      });
      await flush();
    });

    const event = builder.toJSON();
    const crumb = event.meta?.["fire_and_forget.reminder.satisfy.enqueue"] as
      { error: string; userScope?: string } | undefined;
    expect(crumb).toBeDefined();
    expect(crumb?.error).toBe("boom");
    expect(crumb?.userScope).toBe("u_1");
  });

  it("warns with the action label only — never the error payload", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fireAndForget(() => Promise.reject(new Error("secret-token-xyz")), {
      action: "integration.reauth.mark",
    });
    await flush();
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = warn.mock.calls[0].join(" ");
    expect(logged).toContain("integration.reauth.mark");
    expect(logged).not.toContain("secret-token-xyz");
  });

  it("is a safe no-op outside a request context", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => {
      fireAndForget(() => Promise.reject(new Error("no context")), {
        action: "test.orphan.run",
      });
    }).not.toThrow();
    await flush();
  });

  it("coerces a non-Error rejection to a string message", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const builder = new WideEventBuilder();
    await eventStorage.run(builder, async () => {
      fireAndForget(() => Promise.reject("plain-string"), {
        action: "test.reject.string",
      });
      await flush();
    });
    const crumb = builder.toJSON().meta?.[
      "fire_and_forget.test.reject.string"
    ] as { error: string } | undefined;
    expect(crumb?.error).toBe("plain-string");
  });
});
