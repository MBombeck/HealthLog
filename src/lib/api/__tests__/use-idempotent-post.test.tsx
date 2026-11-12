/**
 * A second tap on Save after the first answer was lost must not store the
 * entry twice. The per-call key the transport mints changes with every
 * call, so a create form sends one key until a save lands.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useIdempotentPost } from "../use-idempotent-post";

type Post = ReturnType<typeof useIdempotentPost>;

function openForm(): Post {
  let post: Post | null = null;
  function Probe() {
    post = useIdempotentPost();
    return null;
  }
  renderToStaticMarkup(<Probe />);
  return post!;
}

const fetchMock = vi.fn();

function keyOf(call: number): string | null {
  const init = fetchMock.mock.calls[call]![1] as RequestInit;
  return new Headers(init.headers).get("Idempotency-Key");
}

const stored = () =>
  new Response(JSON.stringify({ data: { id: "e1" }, error: null }), {
    status: 201,
    headers: { "Content-Type": "application/json" },
  });

beforeEach(() => vi.stubGlobal("fetch", fetchMock));
afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

describe("useIdempotentPost", () => {
  it("sends the first key again when the first answer never arrived", async () => {
    fetchMock
      .mockRejectedValueOnce(new DOMException("timed out", "TimeoutError"))
      .mockResolvedValueOnce(stored());
    const post = openForm();

    await expect(post("/api/mood-entries", { mood: "GOOD" })).rejects.toThrow();
    await post("/api/mood-entries", { mood: "GOOD" });

    expect(keyOf(0)).toBeTruthy();
    expect(keyOf(1)).toBe(keyOf(0));
  });

  it("takes a new key for the next entry once a save landed", async () => {
    fetchMock.mockResolvedValueOnce(stored()).mockResolvedValueOnce(stored());
    const post = openForm();

    await post("/api/mood-entries", { mood: "GOOD" });
    await post("/api/mood-entries", { mood: "GOOD" });

    expect(keyOf(1)).not.toBe(keyOf(0));
  });

  it("takes a new key once the server refused the entry", async () => {
    // The refusal is stored under the key, so the corrected retry under it
    // ran unprotected and an unchanged one replayed the refusal.
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ data: null, error: "Name taken", meta: {} }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(stored());
    const post = openForm();

    await expect(
      post("/api/custom-metrics", { name: "Steps" }),
    ).rejects.toThrow();
    await post("/api/custom-metrics", { name: "Steps" });

    expect(keyOf(1)).not.toBe(keyOf(0));
  });

  it("keeps the key while the first request is still running", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: null,
            error: "A request with this Idempotency-Key is already in progress",
          }),
          {
            status: 409,
            headers: {
              "Content-Type": "application/json",
              "X-Idempotent-Replay": "false",
            },
          },
        ),
      )
      .mockResolvedValueOnce(stored());
    const post = openForm();

    await expect(post("/api/mood-entries", { mood: "GOOD" })).rejects.toThrow();
    await post("/api/mood-entries", { mood: "GOOD" });

    expect(keyOf(1)).toBe(keyOf(0));
  });

  it("keeps a header the caller set", async () => {
    fetchMock.mockResolvedValueOnce(stored());
    const post = openForm();

    await post("/api/x", {}, { headers: { Prefer: "respond-async" } });

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(new Headers(init.headers).get("Prefer")).toBe("respond-async");
  });
});
