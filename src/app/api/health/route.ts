import { prisma } from "@/lib/db";
import { getWorkerStatus } from "@/lib/jobs/worker-status";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const checks: Record<string, string> = {
    status: "ok",
    timestamp: new Date().toISOString(),
  };

  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = "connected";
  } catch {
    checks.database = "disconnected";
    checks.status = "degraded";
  }

  const worker = getWorkerStatus();
  checks.worker = worker.running ? "running" : "stopped";
  if (worker.lastHeartbeat) {
    checks.workerLastHeartbeat = worker.lastHeartbeat;
  }
  if (!worker.running) {
    checks.status = "degraded";
  }

  const statusCode = checks.status === "ok" ? 200 : 503;

  return NextResponse.json(checks, { status: statusCode });
}
