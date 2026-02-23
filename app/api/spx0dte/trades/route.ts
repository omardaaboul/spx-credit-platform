import { NextResponse } from "next/server";
import { listTrades, type TradeStatus } from "@/lib/server/tradeMemory";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const statusRaw = url.searchParams.get("status");
  const limitRaw = url.searchParams.get("limit");
  const status = statusRaw == null ? undefined : (String(statusRaw).toUpperCase() as TradeStatus);
  const limit = limitRaw == null ? undefined : Number(limitRaw);
  const rows = listTrades({
    status,
    limit: Number.isFinite(limit) ? Number(limit) : undefined,
  });
  return NextResponse.json({ ok: true, trades: rows }, { status: 200 });
}
