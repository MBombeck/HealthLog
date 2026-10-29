/**
 * The network boundary for browser tests.
 *
 * Components talk to the server through `@/lib/api/api-fetch`, which calls
 * the global `fetch`. Replacing `fetch` and nothing else keeps everything
 * above it real: the envelope unwrapping, the idempotency header, TanStack
 * Query's caching and retries, the component's own pending and error states.
 * Never mock `@tanstack/react-query` or the API wrapper in this project; a
 * test that does asserts its own stand-in.
 *
 * Every request is recorded with its parsed JSON body, so a form test asserts
 * the payload the server would receive. A route can answer later than the
 * request (`deferred`), which is how a test holds a form in its pending
 * state. A request no route matches fails with a 404 envelope and is recorded
 * too, so an unexpected call is visible rather than hanging.
 *
 * Nothing is ambient: the locale mirror (`PUT /api/auth/me/locale`) belongs
 * to `LocaleServerSyncBridge` in the app's providers, which `renderWithApp`
 * does not mount, so "nothing was sent" means nothing the component under
 * test sent.
 *
 * `setup.ts` restores the real `fetch` after every test.
 */
export interface RecordedRequest {
  method: string;
  /** Path and query, without the origin. */
  path: string;
  headers: Headers;
  /** The parsed JSON body, or the raw text when it is not JSON. */
  body: unknown;
}

export interface StubResponse {
  status?: number;
  /** The envelope's `data`. Ignored when `error` is set. */
  data?: unknown;
  error?: string;
  /** The envelope's `meta` (an error's `errorCode`, a list's totals). */
  meta?: Record<string, unknown>;
}

type Responder = (
  request: RecordedRequest,
) => StubResponse | Promise<StubResponse>;

interface Route {
  method: string;
  path: string | RegExp;
  respond: Responder;
}

export interface FetchStub {
  /** Answer `method path` (exact path, or a pattern) with `response`. */
  on(
    method: string,
    path: string | RegExp,
    response: StubResponse | Responder,
  ): FetchStub;
  /**
   * Answer `method path` only when `release` is called, for asserting the
   * pending state in between.
   */
  deferred(
    method: string,
    path: string | RegExp,
  ): { release: (response?: StubResponse) => void };
  /** Every request so far, in order. */
  requests: RecordedRequest[];
  /** The requests that hit `method path`. */
  calls(method: string, path: string | RegExp): RecordedRequest[];
}

let realFetch: typeof fetch | null = null;

function matches(route: Route, method: string, path: string): boolean {
  if (route.method !== method) return false;
  const bare = path.split("?")[0];
  return typeof route.path === "string"
    ? route.path === bare
    : route.path.test(path);
}

function envelope({ status = 200, data = null, error, meta }: StubResponse) {
  const body = {
    ...(error ? { data: null, error } : { data, error: null }),
    ...(meta ? { meta } : {}),
  };
  return new Response(JSON.stringify(body), {
    status: error && status === 200 ? 400 : status,
    headers: { "content-type": "application/json" },
  });
}

async function record(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<RecordedRequest> {
  const request = new Request(input, init);
  const url = new URL(request.url, window.location.href);
  const text = request.method === "GET" ? "" : await request.text();
  let body: unknown = text === "" ? undefined : text;
  try {
    if (text !== "") body = JSON.parse(text);
  } catch {
    // Keep the raw text.
  }
  return {
    method: request.method,
    path: `${url.pathname}${url.search}`,
    headers: request.headers,
    body,
  };
}

/** Replace `fetch` for the rest of the test. */
export function stubFetch(): FetchStub {
  realFetch ??= window.fetch;
  const routes: Route[] = [];
  const requests: RecordedRequest[] = [];

  window.fetch = async (input, init) => {
    const request = await record(input, init);
    requests.push(request);
    // The newest route wins, so a test can override a default it set up.
    const route = [...routes]
      .reverse()
      .find((r) => matches(r, request.method, request.path));
    if (!route) {
      return envelope({
        status: 404,
        error: `no stubbed route for ${request.method} ${request.path}`,
      });
    }
    return envelope(await route.respond(request));
  };

  const stub: FetchStub = {
    requests,
    on(method, path, response) {
      routes.push({
        method,
        path,
        respond: typeof response === "function" ? response : () => response,
      });
      return stub;
    },
    deferred(method, path) {
      let release: (response?: StubResponse) => void = () => {};
      const answer = new Promise<StubResponse>((resolve) => {
        release = (response = {}) => resolve(response);
      });
      routes.push({ method, path, respond: () => answer });
      return { release: (response) => release(response) };
    },
    calls(method, path) {
      return requests.filter((r) =>
        matches({ method, path, respond: () => ({}) }, r.method, r.path),
      );
    },
  };
  return stub;
}

/** Called by `setup.ts` after each test. */
export function restoreFetch(): void {
  if (realFetch) window.fetch = realFetch;
  realFetch = null;
}
