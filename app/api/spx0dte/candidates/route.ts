import { NextResponse } from "next/server";
import {
  listCandidates,
  upsertCandidates,
  upsertCandidatesFromDashboard,
  type CandidateStatus,
  type TradeCandidateRecord,
} from "@/lib/server/tradeMemory";
import type { DashboardPayload } from "@/lib/spx0dte";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const dteRaw = url.searchParams.get("dte");
  const statusRaw = url.searchParams.get("status");
  const decisionRaw = url.searchParams.get("decision");
  const limitRaw = url.searchParams.get("limit");

  const dte = dteRaw == null ? undefined : Number(dteRaw);
  const status = statusRaw == null ? undefined : (String(statusRaw).toUpperCase() as CandidateStatus);
  const decision = decisionRaw == null ? undefined : (String(decisionRaw).toUpperCase() as "SKIPPED" | "WATCHLIST" | "TAKEN");
  const limit = limitRaw == null ? undefined : Number(limitRaw);

  const rows = listCandidates({
    dte: Number.isFinite(dte) ? Number(dte) : undefined,
    status,
    decision,
    limit: Number.isFinite(limit) ? Number(limit) : undefined,
  });
  return NextResponse.json({ ok: true, candidates: rows }, { status: 200 });
}

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, message: "Invalid JSON body." }, { status: 400 });
  }

  const payload = body.payload as DashboardPayload | undefined;
  if (payload && typeof payload === "object") {
    const result = upsertCandidatesFromDashboard(payload);
    return NextResponse.json({ ok: true, message: "Candidates stored from payload.", ...result }, { status: 200 });
  }

  const rowsRaw = body.candidates;
  if (!Array.isArray(rowsRaw)) {
    return NextResponse.json({ ok: false, message: "Expected `payload` or `candidates[]`." }, { status: 400 });
  }

  const rows = rowsRaw as TradeCandidateRecord[];
  const result = upsertCandidates(rows);
  return NextResponse.json({ ok: true, message: "Candidates upserted.", ...result }, { status: 200 });
}
