/**
 * #1279 — the HTTP requests one completion call may send.
 *
 * The Local and the OpenAI-compatible gateway clients send a request again on
 * their own: without a reasoning field the endpoint refused, without the JSON
 * flag it refused, with `reasoning_effort: "none"` after a reply that
 * reasoned without answering, and the Local stream falls back to a buffered
 * request. Each repeat was bounded by what it had just learned, and two
 * lessons that undo each other were not bounded at all: a gateway that
 * refuses `reasoning_effort` in front of a model that reasons unasked made
 * one call send requests until something outside stopped it.
 *
 * So each call carries one budget through every repeat, and the budget bounds
 * it, not the lessons: at most `MAX_REQUESTS_PER_CALL` requests, after which
 * the call ends with the failure it has. What was learned on the way still
 * holds for the next call. `ai-request-hops-guard.test.ts` holds both clients
 * to sending only through here and to handing the budget to every repeat.
 *
 * Server-only.
 */
import { safeFetch } from "@/lib/safe-fetch";

/** The requests one call may send: the first, and one repeat. */
export const MAX_REQUESTS_PER_CALL = 2;

export class RequestHops {
  private sent = 0;

  /** True while the call may send one more request. */
  get canSend(): boolean {
    return this.sent < MAX_REQUESTS_PER_CALL;
  }

  /**
   * `safeFetch`, counted. A request past the budget is not sent: every repeat
   * asks `canSend` first, so this throw marks a repeat that did not.
   */
  fetch(...args: Parameters<typeof safeFetch>): Promise<Response> {
    if (!this.canSend) {
      return Promise.reject(
        Object.assign(new Error("AI call has no request left to send"), {
          httpStatus: 0,
        }),
      );
    }
    this.sent += 1;
    return safeFetch(...args);
  }
}
