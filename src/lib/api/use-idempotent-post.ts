"use client";

import { useRef } from "react";

import { apiPost } from "@/lib/api/api-fetch";
import { randomId } from "@/lib/random-id";

/**
 * `apiPost` for a create form, under one `Idempotency-Key` until a save lands.
 *
 * The transport mints a fresh key per call, which covers a replayed request
 * but not a second tap on Save: when the first answer never arrived (the 15 s
 * timeout on a weak signal) the entry is already stored, and the retry is a
 * new call with a new key, so the server stored it twice. Every submit
 * through this function sends the same key until one succeeds, so the retry
 * replays the first answer instead; a retry with a changed body is a
 * different request and runs as one. The next entry gets a new key.
 */
export function useIdempotentPost() {
  const key = useRef<string | null>(null);
  return async function post<T = unknown>(
    path: string,
    body?: unknown,
    init?: RequestInit,
  ): Promise<T> {
    key.current ??= randomId();
    const headers = new Headers(init?.headers);
    headers.set("Idempotency-Key", key.current);
    const result = await apiPost<T>(path, body, { ...init, headers });
    key.current = null;
    return result;
  };
}
