import { NextResponse } from "next/server";
import { rejectCandidate } from "@/lib/server/tradeMemory";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, message: "Invalid JSON body." }, { status: 400 });
  }

  const candidateId = String(body.candidate_id ?? "").trim();
  if (!candidateId) return NextResponse.json({ ok: false, message: "Missing candidate_id." }, { status: 400 });
  const decisionRaw = String(body.decision ?? "SKIPPED").toUpperCase();
  if (decisionRaw !== "SKIPPED" && decisionRaw !== "WATCHLIST") {
    return NextResponse.json({ ok: false, message: "Decision must be SKIPPED or WATCHLIST." }, { status: 400 });
  }

  const result = rejectCandidate({
    candidate_id: candidateId,
    decision: decisionRaw,
    notes: body.notes == null ? null : String(body.notes),
  });
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
