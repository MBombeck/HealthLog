/**
 * The refusal a demo deploy answers a write with (`DEMO_MODE=true`): the
 * proxy's mutation block and the routes that bypass the proxy send the same
 * body, a 403 whose `meta.errorCode` names it, so a client can tell "the demo
 * does not do this" from an outage and say so.
 *
 * Client-safe: no server import.
 */
export const DEMO_READ_ONLY_CODE = "demo.readOnly";

export const DEMO_REFUSAL_BODY = {
  data: null,
  error: "Demo mode: modifications are disabled",
  meta: { demo: true, errorCode: DEMO_READ_ONLY_CODE },
} as const;
