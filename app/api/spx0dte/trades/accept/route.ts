import { NextResponse } from "next/server";
import { acceptCandidateAsTrade } from "@/lib/server/tradeMemory";

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

  const result = acceptCandidateAsTrade({
    candidate_id: candidateId,
    quantity: Number(body.quantity ?? 1),
    filled_credit: body.filled_credit == null ? undefined : Number(body.filled_credit),
    fees_estimate: body.fees_estimate == null ? undefined : Number(body.fees_estimate),
    notes: body.notes == null ? null : String(body.notes),
  });
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
