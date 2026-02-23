import { NextResponse } from "next/server";
import { closeTrade } from "@/lib/server/tradeMemory";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, message: "Invalid JSON body." }, { status: 400 });
  }

  const tradeId = String(body.trade_id ?? "").trim();
  if (!tradeId) return NextResponse.json({ ok: false, message: "Missing trade_id." }, { status: 400 });
  const closePrice = body.close_price == null ? undefined : Number(body.close_price);
  const result = closeTrade({
    trade_id: tradeId,
    close_price: Number.isFinite(closePrice) ? closePrice : undefined,
    notes: body.notes == null ? null : String(body.notes),
  });
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
