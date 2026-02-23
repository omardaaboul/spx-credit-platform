import { NextResponse } from "next/server";
import {
  effectiveRuntimeDataMode,
  operationalModeLabel,
  requiredEnvIssues,
  simulationModeEnabled,
} from "@/lib/server/runtimeEnv";

export const dynamic = "force-dynamic";

export async function GET() {
  const issues = requiredEnvIssues();
  const status = issues.length > 0 ? "error" : "ok";

  return NextResponse.json(
    {
      status,
      mode: operationalModeLabel(),
      timestamp: new Date().toISOString(),
      dataMode: effectiveRuntimeDataMode(),
      simulationMode: simulationModeEnabled(),
      issues,
    },
    { status: issues.length > 0 ? 503 : 200 },
  );
}
