/**
 * v1.42 — the logging pieces the error-log discipline rests on.
 *
 *   - `emitSignal` writes its own line with a stable action and level, joined
 *     to the surrounding event by request and trace id, and leaves that event
 *     alone.
 *   - `setError` keeps `error` for real failures and records a refusal the
 *     request was meant to get (any 4xx) at `warn`. Expired-token 401s made up
 *     most of the error lines and hid the real ones.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const emitted: Array<Record<string, unknown>> = [];
vi.mock("../transports", () => ({
  emitIfSampled: (event: Record<string, unknown>) => emitted.push(event),
}));

import { WideEventBuilder } from "../event-builder";
import { eventStorage } from "../context";
import { emitSignal, logCaught } from "../signal";

beforeEach(() => {
  emitted.length = 0;
});

describe("emitSignal", () => {
  it("writes one line with its own action and level, joined to the parent by id", () => {
    const parent = new WideEventBuilder("http");
    parent.setAction({ name: "insights.generate" });
    eventStorage.run(parent, () =>
      emitSignal({
        action: "ai.chain.link_failed",
        level: "error",
        meta: { provider: "admin-openai", status: 500 },
      }),
    );
    expect(emitted).toHaveLength(1);
    const line = emitted[0] as {
      action: { name: string };
      level: string;
      request_id: string;
      trace_id: string;
      meta: Record<string, unknown>;
    };
    expect(line.action.name).toBe("ai.chain.link_failed");
    expect(line.level).toBe("error");
    expect(line.request_id).toBe(parent.getRequestId());
    expect(line.trace_id).toBe(parent.getTraceId());
    expect(line.meta).toMatchObject({ provider: "admin-openai", status: 500 });
    // The parent keeps its own action and level.
    expect(parent.toJSON().action?.name).toBe("insights.generate");
    expect(parent.getLevel()).toBe("info");
  });

  it("logCaught carries the error's type and a bounded, redacted message at warn", () => {
    logCaught(
      "jobs.enqueue.failed",
      new Error(`boom Bearer sk-abcdefghijklmnopqrstuvwxyz ${"x".repeat(500)}`),
      { queue: "insight-pregenerate" },
    );
    const line = emitted[0] as { level: string; meta: Record<string, string> };
    expect(line.level).toBe("warn");
    expect(line.meta.error_type).toBe("Error");
    expect(line.meta.error_message.length).toBeLessThanOrEqual(240);
    expect(line.meta.error_message).not.toContain("sk-abcdefghijklmnop");
  });

  it("never throws, even when emitting fails", () => {
    expect(() =>
      emitSignal({
        action: "x.y.z",
        level: "warn",
        meta: {
          get bad(): never {
            throw new Error("getter");
          },
        },
      }),
    ).not.toThrow();
  });
});

describe("setError level", () => {
  it("records a 4xx refusal at warn", () => {
    const evt = new WideEventBuilder("http");
    evt.setError(
      Object.assign(new Error("Token expired"), { statusCode: 401 }),
    );
    expect(evt.getLevel()).toBe("warn");
    expect(evt.toJSON().error?.message).toBe("Token expired");
  });

  it("keeps a real failure at error", () => {
    const evt = new WideEventBuilder("http");
    evt.setError(new Error("database unreachable"));
    expect(evt.getLevel()).toBe("error");
    const five = new WideEventBuilder("http");
    five.setError(Object.assign(new Error("bad gateway"), { statusCode: 502 }));
    expect(five.getLevel()).toBe("error");
  });
});
