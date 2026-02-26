import { NextResponse } from "next/server";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  effectiveRuntimeDataMode,
  operationalModeLabel,
  requiredEnvIssues,
  simulationModeEnabled,
} from "@/lib/server/runtimeEnv";

export const dynamic = "force-dynamic";

const PROVIDER_HEALTH_STATE_PATH = path.join(process.cwd(), "storage", ".provider_health_state.json");

type ProviderHealthState = {
  provider_status?: "tastytrade-live" | "tastytrade-partial" | "down";
  auth_status?: "ok" | "refreshing" | "failed";
  last_auth_ok_ts?: string | null;
};

function loadProviderHealthState(): Required<ProviderHealthState> {
  try {
    if (!existsSync(PROVIDER_HEALTH_STATE_PATH)) {
      return { provider_status: "down", auth_status: "failed", last_auth_ok_ts: null };
    }
    const parsed = JSON.parse(readFileSync(PROVIDER_HEALTH_STATE_PATH, "utf8")) as ProviderHealthState;
    return {
      provider_status: parsed.provider_status ?? "down",
      auth_status: parsed.auth_status ?? "failed",
      last_auth_ok_ts: parsed.last_auth_ok_ts ?? null,
    };
  } catch {
    return { provider_status: "down", auth_status: "failed", last_auth_ok_ts: null };
  }
}

export async function GET() {
  const issues = [...requiredEnvIssues()];
  const provider = loadProviderHealthState();
  const providerDegraded = provider.provider_status === "down" || provider.auth_status === "failed" || provider.auth_status === "refreshing";
  if (provider.auth_status === "failed" && !issues.includes("TASTY_AUTH_FAILED")) {
    issues.push("TASTY_AUTH_FAILED");
  }
  const status = issues.length > 0 ? "error" : providerDegraded ? "degraded" : "ok";

  return NextResponse.json(
    {
      status,
      mode: operationalModeLabel(),
      timestamp: new Date().toISOString(),
      dataMode: effectiveRuntimeDataMode(),
      simulationMode: simulationModeEnabled(),
      auth_status: provider.auth_status,
      provider_status: provider.provider_status,
      last_auth_ok_ts: provider.last_auth_ok_ts,
      issues,
    },
    { status: issues.length > 0 ? 503 : 200 },
  );
}
