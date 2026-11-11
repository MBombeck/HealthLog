"use client";

/**
 * v1.15.18 — legacy intake-history route.
 *
 * The full intake history folded into the medication detail page's
 * Verlauf tab. This route stays only as a deep-link redirect so existing
 * bookmarks and any iOS deep-link keep landing on the right surface.
 */

import { use, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

export default function IntakeHistoryRedirectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();

  useEffect(() => {
    router.replace(`/medications/${id}?tab=history`);
  }, [id, router]);

  return (
    <div
      className="flex h-64 items-center justify-center"
      role="status"
      aria-busy="true"
      aria-live="polite"
    >
      <Loader2
        aria-hidden="true"
        className="text-primary h-8 w-8 animate-spin motion-reduce:animate-none"
      />
    </div>
  );
}
