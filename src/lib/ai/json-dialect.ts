/**
 * Per-endpoint JSON-mode dialect, learned at runtime.
 *
 * Landed for the Local client in v1.28.28 (#470) and shared with the
 * OpenAI-compatible gateway provider in v1.33.1 — both talk to endpoints
 * HealthLog does not control, and both need the same answer to the same
 * question: does this endpoint accept the standard
 * `response_format: { type: "json_object" }` field?
 *
 *  - `"response_format"` (the default): send the standard OpenAI field.
 *    Strict OpenAI-compatible gateways (LiteLLM, OpenRouter, vLLM) and
 *    Ollama's own `/v1` shim all accept it.
 *  - `"none"`: send no structured-output flag at all. Whatever JSON steering
 *    the caller already put in the prompt is the only steering left.
 *    (Ollama's NATIVE top-level `format: "json"` never belonged on the
 *    OpenAI-compatible `/chat/completions` wire — it 400s on strict
 *    gateways — so the fallback stays minimal rather than resurrecting it.)
 *
 * The dialect is cached per base URL for the process lifetime: the first
 * JSON-mode request that 4xxes with a body referencing `response_format` or
 * an unknown parameter flips that endpoint to `"none"` and is retried once
 * without the flag. A successful flagged request pins `"response_format"` so
 * a later transient 4xx cannot silently degrade the endpoint.
 *
 * The cache is keyed by base URL, not by provider, so two providers pointed
 * at the same gateway learn once between them.
 */

export type JsonModeDialect = "response_format" | "none";

const dialectByBaseUrl = new Map<string, JsonModeDialect>();

/** The learned dialect for an endpoint, defaulting to the standard field. */
export function jsonModeDialectFor(baseUrl: string): JsonModeDialect {
  return dialectByBaseUrl.get(baseUrl) ?? "response_format";
}

/** True once an endpoint's dialect has actually been observed. */
export function hasLearnedJsonModeDialect(baseUrl: string): boolean {
  return dialectByBaseUrl.has(baseUrl);
}

/** Record what an endpoint answered to. */
export function rememberJsonModeDialect(
  baseUrl: string,
  dialect: JsonModeDialect,
): void {
  dialectByBaseUrl.set(baseUrl, dialect);
}

/** Test hook — clears the learned per-endpoint dialect cache. */
export function resetJsonModeDialectCache(): void {
  dialectByBaseUrl.clear();
}

/**
 * True when a 4xx error body reads as "this endpoint rejects the
 * `response_format` field" — either it names the field outright or it
 * complains about an unknown/unexpected parameter. A complaint that names
 * `reasoning_effort` and not `response_format` is about the reasoning field,
 * so it must not switch the endpoint's JSON mode off.
 */
export function isResponseFormatRejection(
  status: number,
  bodyExcerpt: string,
): boolean {
  if (status < 400 || status >= 500) return false;
  if (
    /reasoning[\s_-]*effort/i.test(bodyExcerpt) &&
    !/response_format/i.test(bodyExcerpt)
  ) {
    return false;
  }
  return (
    /response_format/i.test(bodyExcerpt) ||
    /(unknown|unexpected|unrecognized|unsupported|extra)[\s_-]*(parameter|field|argument|property|key)/i.test(
      bodyExcerpt,
    )
  );
}
