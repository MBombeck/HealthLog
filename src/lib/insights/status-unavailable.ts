/**
 * What a status route answers while the `statusText` capability is
 * unavailable.
 *
 * The status family (`*-status`, `metric-status`, `biomarker-assessment`) is
 * a mixed read: the card around the note is data, the note is model output.
 * With the capability unavailable, for any reason, the route answers 200 with
 * no note and says why:
 *
 *   - `text: null`: stored model text is never served, however fresh.
 *   - `preparing: false`: nothing is warming, because nothing was enqueued.
 *   - `hasProvider`: provider presence and nothing else. A shipped native
 *     client renders "no provider" copy for `false`, so it must not be false
 *     because the operator switched notes off or consent is missing.
 *   - `ai`: the resolved state, so a client can say why without guessing.
 *
 * The route builds this instead of calling the generator, so no cache row is
 * read and no generation is queued.
 */
import { probeProviderPresence } from "@/lib/ai/provider";
import type { AiCapabilityState } from "@/lib/ai/capabilities/types";

export interface UnavailableStatusBody {
  hasProvider: boolean;
  text: null;
  cached: false;
  updatedAt: null;
  preparing: false;
  ai: AiCapabilityState;
}

export async function unavailableStatusBody(
  recordId: string,
  ai: AiCapabilityState,
): Promise<UnavailableStatusBody> {
  return {
    hasProvider: await probeProviderPresence(recordId, "text", "statusText"),
    text: null,
    cached: false,
    updatedAt: null,
    preparing: false,
    ai,
  };
}

/** The medication-compliance card's shape: a summary plus per-medication notes. */
export interface UnavailableComplianceStatusBody {
  hasProvider: boolean;
  summary: null;
  medications: [];
  cached: false;
  updatedAt: null;
  preparing: false;
  ai: AiCapabilityState;
}

export async function unavailableComplianceStatusBody(
  recordId: string,
  ai: AiCapabilityState,
): Promise<UnavailableComplianceStatusBody> {
  return {
    hasProvider: await probeProviderPresence(recordId, "text", "statusText"),
    summary: null,
    medications: [],
    cached: false,
    updatedAt: null,
    preparing: false,
    ai,
  };
}
