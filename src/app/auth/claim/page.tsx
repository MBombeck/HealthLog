"use client";

import { useSearchParams } from "next/navigation";

import { ClaimProfile } from "@/components/auth/claim-profile";

/**
 * v1.42 (#959) — `/auth/claim?token=hlp_…`, where the link a Guardian handed
 * over (`/claim/<token>`) lands after the edge redirect.
 *
 * A URL-credential surface by shape (`session-surface-guard.test.ts`, S2): the
 * page reads the one-time token off the query string and passes it to the
 * form, which sends it only in the BODY of the anonymous preview and claim
 * requests. Nothing here resolves the token; those two routes do, behind one
 * uniform 404 and a per-address rate limit.
 */
export default function ClaimProfilePage() {
  const searchParams = useSearchParams();
  return <ClaimProfile token={searchParams.get("token")} />;
}
