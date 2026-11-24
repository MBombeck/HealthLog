/**
 * Every queue the worker can declare, on any deploy. The registry is built at
 * import under the test env, which is not a demo deploy, so the demo-only
 * queues (`maintenanceDemoJobs`) are absent from it; the structural guards
 * still hold them to the same tables as every other queue.
 */
import type { JobDefinition } from "@/lib/jobs/registry/define-job";
import { allJobDefinitions } from "@/lib/jobs/registry/index";
import { maintenanceDemoJobs } from "@/lib/jobs/registry/maintenance-demo";

export function everyJobDefinition(): readonly JobDefinition[] {
  const saved = process.env.DEMO_MODE;
  process.env.DEMO_MODE = "true";
  try {
    const registered = allJobDefinitions();
    const queues = new Set(registered.map((d) => d.queue));
    return [
      ...registered,
      ...maintenanceDemoJobs().filter((d) => !queues.has(d.queue)),
    ];
  } finally {
    if (saved === undefined) delete process.env.DEMO_MODE;
    else process.env.DEMO_MODE = saved;
  }
}
