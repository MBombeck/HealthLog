import { NextResponse } from "next/server";
import { apiHandler } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { getPublicMonitoringSettings } from "@/lib/monitoring-settings";
import { fetchUmamiScript } from "@/lib/monitoring/umami";

export const dynamic = "force-dynamic";

const NOOP_SCRIPT = "/* umami disabled */";

export const GET = apiHandler(async () => {
  annotate({ action: { name: "monitoring.umami-script" } });

  const settings = await getPublicMonitoringSettings();
  if (
    !settings.umamiEnabled ||
    !settings.umamiScriptUrl ||
    !settings.umamiWebsiteId
  ) {
    return new NextResponse(NOOP_SCRIPT, {
      status: 200,
      headers: {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "public, max-age=60",
      },
    });
  }

  // Fail-soft: an unreachable / slow / rebinding-refused upstream degrades
  // to the noop script, never a 500 on every mount. The failure stays
  // observable under its own action name on the wide-event dashboards.
  const fetched = await fetchUmamiScript(settings.umamiScriptUrl);
  if (!fetched.ok) {
    annotate({
      action: { name: "monitoring.umami_script.fetch_failed" },
      meta: { reason: fetched.reason },
    });
    return new NextResponse(NOOP_SCRIPT, {
      status: 200,
      headers: {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "public, max-age=60",
      },
    });
  }

  return new NextResponse(fetched.script, {
    status: 200,
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=1800",
    },
  });
});
