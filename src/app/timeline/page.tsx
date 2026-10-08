"use client";

import { Suspense, useEffect } from "react";
import { useRouter } from "next/navigation";

import { PageAuthGate } from "@/components/ui/page-auth-gate";
import { useAuth } from "@/hooks/use-auth";
import { TimelineView } from "@/components/timeline/timeline-view";

/**
 * v1.42 (#613): the life timeline.
 *
 * The `timeline` module is opt-in, and its switch lives in Settings. With
 * the module off the navigation entry is gone, and a deep link lands on the
 * shell's module notice (`ModulePageGate`, through `nav:/timeline` in the
 * surface map) instead of this page, which never mounts and so never asks
 * the server, whose routes refuse on their own. An unauthenticated visitor
 * is sent to login.
 *
 * The view reads `?day=` and `?add=` through `useSearchParams`, which needs
 * a boundary on a statically rendered page.
 */
export default function TimelinePage() {
  const { isLoading, isAuthenticated } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!isLoading && !isAuthenticated) router.push("/auth/login");
  }, [isLoading, isAuthenticated, router]);

  if (isLoading || !isAuthenticated) return <PageAuthGate />;

  return (
    <Suspense fallback={<PageAuthGate />}>
      <TimelineView />
    </Suspense>
  );
}
