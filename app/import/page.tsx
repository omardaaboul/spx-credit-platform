"use client";

import { useMemo, useState } from "react";
import Papa from "papaparse";
import { db, Trade, Cashflow, CashflowCategory } from "@/lib/db";

type ImportSource = "csv" | "pdf";

type TradeDraft = {
  ticker: string;
  type?: string;
  openDate?: string;
  closeDate?: string;
  totalPL?: number;
  notes?: string;
  quantity?: number; // NEW (contracts)
  price?: number;    // NEW (option price)
};

type CashflowDraft = {
  date: string;
  month: string;
  category: CashflowCategory;
  amount: number;
  ticker?: string;
  notes?: string;
  rawType?: string;

  // NEW: store execution details for EQUITY realized P/L calc later
  quantity?: number;
  price?: number;
  side?: "BUY" | "SELL";
};

type ParseResult = {
  trades: TradeDraft[];
  cashflows: CashflowDraft[];
  warnings: string[];
  errors: string[];
  skipped: number;
};

type ParseLineResult<T> =
  | {
      draft: T;
      error?: never;
    }
  | {
      draft?: never;
      error: string;
    };

function parseMoney(input?: string) {
  if (!input) return undefined;
  const s = String(input).trim();
  if (!s) return undefined;
  const negative = /\(.*\)/.test(s);
  const cleaned = s.replace(/[(),$]/g, "");
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return undefined;
  return negative ? -n : n;
}

function toISODate(s?: string): string | undefined {
  if (!s) return undefined;

  // If already ISO (YYYY-MM-DD), accept it
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // Handle MM/DD/YYYY or M/D/YYYY (and also MM/DD/YY)
  const parts = s.split("/");
  if (parts.length !== 3) return undefined;

  const mm = Number(parts[0]);
  const dd = Number(parts[1]);
  let yy = Number(parts[2]);

  if (!mm || !dd || !yy) return undefined;
  if (yy < 100) yy += 2000;

  const d = new Date(Date.UTC(yy, mm - 1, dd));
  if (Number.isNaN(d.getTime())) return undefined;

  return d.toISOString().slice(0, 10);
}

function monthFromSlash(date?: string) {
  if (!date) return "";
  const iso = toISODate(date);
  if (!iso) return "";
  return iso.slice(0, 7);
}

function parseAction(type?: string, notes?: string) {
  const s = `${type ?? ""} ${notes ?? ""}`.toUpperCase();
  if (s.includes("STO")) return "STO";
  if (s.includes("BTC")) return "BTC";
  if (s.includes("BTO")) return "BTO";
  if (s.includes("STC")) return "STC";
  return "";
}

function detectSource(file?: File | null): ImportSource {
  if (!file) return "csv";
  const name = file.name.toLowerCase();
  if (name.endsWith(".pdf")) return "pdf";
  return "csv";
}

function lastDate(line: string) {
  const matches = line.match(/\d{2}\/\d{2}\/\d{4}/g);
  return matches ? matches[matches.length - 1] : undefined;
}

function lastAmount(line: string) {
  const matches = line.match(/\$[\d,.]+/g) ?? [];
  if (!matches.length) return undefined;
  return parseMoney(matches[matches.length - 1]);
}

function parseOptionFillLine(line: string): ParseLineResult<TradeDraft> {
  const head = line.match(/^([A-Z.\-]{1,12})\s+(\d{2}\/\d{2}\/\d{4})\s+(Put|Call)\s+\$([\d,.]+)/i);
  const actionMatch = line.match(/\b(STO|BTC|BTO|STC)\b/);
  const dateMatch = line.match(/\b(STO|BTC|BTO|STC)\s+(\d{2}\/\d{2}\/\d{4})/);

  if (!head || !actionMatch || !dateMatch) {
    return { error: `Unparsed fill line: ${line}` };
  }

  const underlying = head[1].toUpperCase();
  const expiry = head[2];
  const right = head[3];
  const strike = head[4].replace(/,/g, "");
  const notes = `${underlying} ${expiry} ${right} $${strike}`;

  const action = actionMatch[1];
  const date = toISODate(dateMatch[2]);
  const amount = lastAmount(line);

  if (!date || amount == null) {
    return { error: `Fill missing date/amount: ${line}` };
  }

  const totalPL = action === "BTO" || action === "BTC" ? -Math.abs(amount) : Math.abs(amount);

  return {
    draft: {
      ticker: underlying,
      type: action,
      openDate: action === "STO" || action === "BTO" ? date : undefined,
      closeDate: action === "BTC" || action === "STC" ? date : undefined,
      totalPL,
      notes,
    } satisfies TradeDraft,
  };
}

function parseDividendLine(line: string) {
  const reinvestMatch = line.match(/Dividend Reinvestment\s+([A-Z.\-]{1,12})/i);
  const cdivMatch =
    line.match(/\b([A-Z.\-]{1,12})\s+Margin\s+CDIV\b/i) ||
    line.match(/\b([A-Z.\-]{1,12})\b(?=\s+CDIV\b)/i);
  const ticker = (reinvestMatch?.[1] || cdivMatch?.[1] || "").toUpperCase();
  const date =
    toISODate(line.match(/\bCDIV\s+(\d{2}\/\d{2}\/\d{4})/i)?.[1] || lastDate(line));
  const amount = lastAmount(line);

  if (!ticker || !date || amount == null) {
    return { error: `Unparsed dividend line: ${line}` };
  }

  return {
    draft: {
      date,
      month: monthFromSlash(date),
      category: "DIVIDEND",
      amount: Math.abs(amount),
      ticker,
      notes: line,
      rawType: /Reinvestment/i.test(line) ? "DIV_REINV" : "DIV",
    } satisfies CashflowDraft,
  };
}

function parseInterestLine(line: string): ParseLineResult<CashflowDraft> {
  const date = toISODate(lastDate(line));
  const amount = lastAmount(line);
  if (!date || amount == null) {
    return { error: `Unparsed interest line: ${line}` };
  }

  return {
    draft: {
      date,
      month: monthFromSlash(date),
      category: "INTEREST",
      amount: Math.abs(amount),
      ticker: /Sweep/i.test(line) ? "SWEEP" : "CASH",
      notes: line,
      rawType: "INT",
    } satisfies CashflowDraft,
  };
}

function parseFeeLine(line: string): ParseLineResult<CashflowDraft> {
  const date = toISODate(lastDate(line));
  const amount = lastAmount(line);
  if (!date || amount == null) {
    return { error: `Unparsed fee line: ${line}` };
  }

  return {
    draft: {
      date,
      month: monthFromSlash(date),
      category: "FEE",
      amount: -Math.abs(amount),
      ticker: /GOLD/i.test(line) ? "GOLD" : "FEE",
      notes: line,
      rawType: "FEE",
    } satisfies CashflowDraft,
  };
}

function parsePdfText(text: string): ParseResult {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const trades: TradeDraft[] = [];
  const cashflows: CashflowDraft[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  let skipped = 0;

  let inActivity = false;
  let inPending = false;
  let buffer = "";

  for (const raw of lines) {
    if (/^Account Activity\b/i.test(raw)) {
      inActivity = true;
      inPending = false;
      buffer = "";
      continue;
    }

    if (/^Executed Trades Pending Settlement\b/i.test(raw)) {
      inPending = true;
      inActivity = false;
      buffer = "";
      continue;
    }

    if (
      (inActivity || inPending) &&
      /^(Stock Lending|Deposit Sweep|Portfolio Summary|Important Information|Statement of Financial Condition|Notice to Customers|Page of|Total Funds Paid and Received)/i.test(raw)
    ) {
      inActivity = false;
      inPending = false;
      buffer = "";
      continue;
    }

    if (!inActivity && !inPending) continue;

    if (/^Description\b/i.test(raw)) {
      buffer = "";
      continue;
    }

    const line = buffer ? `${buffer} ${raw}` : raw;

    const isFill = /\b(STO|BTC|BTO|STC)\b/.test(line);
    const isDividend = /\b(CDIV|CASH DIV|DIVIDEND)\b/i.test(line);
    const isInterest = /\bINTEREST\b/i.test(line) || /\bINT\b/i.test(line);
    const isFee = /\bFEE\b/i.test(line) || /\bSUBSCRIPTION\b/i.test(line) || /\bGOLD\b/i.test(line);

    if (!isFill && !isDividend && !isInterest && !isFee) {
      const shouldBuffer = !/\d{2}\/\d{2}\/\d{4}/.test(line) && !/\$[\d,.]+/.test(line);
      if (shouldBuffer) {
        buffer = line;
      } else {
        buffer = "";
        skipped += 1;
      }
      continue;
    }

    buffer = "";

    if (isFill) {
      const result = parseOptionFillLine(line);
      if (result.draft) trades.push(result.draft);
      if (result.error) errors.push(result.error);
      continue;
    }

    if (isDividend) {
      const result = parseDividendLine(line);
      if (result.draft) cashflows.push(result.draft);
      if (result.error) errors.push(result.error);
      continue;
    }

    if (isInterest) {
      const result = parseInterestLine(line);
      if (result.draft) cashflows.push(result.draft);
      if (result.error) errors.push(result.error);
      continue;
    }

    if (isFee) {
      const result = parseFeeLine(line);
      if (result.draft) cashflows.push(result.draft);
      if (result.error) errors.push(result.error);
      continue;
    }

    warnings.push(`Unhandled line: ${line}`);
  }

  return { trades, cashflows, warnings, errors, skipped };
}

function normalizeKey(key: string) {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function pick(row: Record<string, unknown>, keys: string[]) {
  const entries = Object.entries(row);
  for (const k of keys) {
    const match = entries.find(([rk]) => normalizeKey(rk) === normalizeKey(k));
    if (match) return match[1];
  }
  return undefined;
}

function parseCsvText(text: string): ParseResult {
  const result = Papa.parse<Record<string, unknown>>(text, {
    header: true,
    skipEmptyLines: true,
  });

  const trades: TradeDraft[] = [];
  const cashflows: CashflowDraft[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  let skipped = 0;

  for (const row of result.data) {
    const notes = String(pick(row, ["Description"]) ?? "").trim();
    const typeRaw = String(pick(row, ["Trans Code", "Type", "Action"]) ?? "").trim();

    const action = parseAction(typeRaw, notes);

    const date =
      toISODate(String(pick(row, ["Activity Date"]) ?? "").trim()) ||
      toISODate(String(pick(row, ["Process Date"]) ?? "").trim()) ||
      toISODate(String(pick(row, ["Settle Date"]) ?? "").trim());

    const tickerRaw = String(pick(row, ["Instrument"]) ?? "").trim();
    const ticker = (tickerRaw || notes.split(" ")[0] || "").toUpperCase();

    // Quantity + Price (NEW)
    const qtyRaw = pick(row, ["Quantity"]) ?? "";
    const priceRaw = pick(row, ["Price"]) ?? "";
    const quantity = Number(String(qtyRaw).replace(/[^\d.-]/g, ""));
    const price = parseMoney(String(priceRaw));

    // Amount
    let totalPL = parseMoney(String(pick(row, ["Amount"]) ?? ""));

    // Basic classification
    const typeField = `${typeRaw} ${notes}`.toUpperCase();
    const transCode = typeRaw.trim().toUpperCase();

    // Option detection (Robinhood format: "SOXS 1/16/2026 Put $4.00")
    const hasPutCall = /\b(PUT|CALL)\b/.test(typeField);
    const hasStrike = /\b(PUT|CALL)\b[^\n\r]*?\b\$?\d{1,6}(?:,\d{3})*(?:\.\d+)?\b/.test(typeField);
    const isOptionText = hasPutCall && hasStrike;
    const notesUpper = notes.toUpperCase();
    const isOptionHint = /\b(PUT|CALL)\b/.test(notesUpper);
    const hasExpiryHint = /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/.test(notesUpper);
    const hasStrikeHint = /\$[\d,]+(?:\.\d+)?/.test(notesUpper);
    const isOptionish = isOptionHint && (hasExpiryHint || hasStrikeHint);

    const isAssignment = ["OASGN", "OEXP", "OCA"].includes(transCode);
    const isOption = (Boolean(action) && isOptionText) || (isAssignment && isOptionText);

    // Category
    let category: CashflowCategory | "FILL" = "OTHER";
    if (isOption) category = "FILL";
    else if (/DIVIDEND|\bDIV\b|CDIV/.test(typeField)) category = "DIVIDEND";
    else if (/STOCK LENDING|\bSLIP\b/.test(typeField)) category = "LENDING";
    else if (/INTEREST|\bINT\b/.test(typeField)) category = "INTEREST";
    else if (/GDBP|DEPOSIT BOOST|BOOST PAYMENT/.test(typeField)) category = "INTEREST";
    else if (/FEE|SUBSCRIPTION|GOLD/.test(typeField)) category = "FEE";
    else if (/SWEEP/.test(typeField)) category = "SWEEP";
    else if (/TRANSFER|ACH|XENT|REVERSAL/.test(typeField)) category = "TRANSFER";
    else if (/\bBUY\b|\bSELL\b/.test(typeField)) category = "EQUITY";

    // Skip empty rows
    const hasValues = Object.values(row).some((v) => String(v ?? "").trim());
    if (!hasValues) {
      skipped += 1;
      continue;
    }

    if (!date) {
      // Continuation line / junk
      if (!typeRaw && /CUSIP|Options Assigned|Option Assigned|Option Expiration/i.test(notes)) {
        warnings.push(`Skipped continuation line: ${notes}`);
        skipped += 1;
        continue;
      }
      if (category === "OTHER") {
        skipped += 1;
        continue;
      }
      errors.push(`Row missing date for targeted category: ${notes || typeRaw || "Unknown row"}`);
      continue;
    }

    // Derive Amount if missing from qty*price
    if (totalPL == null) {
      if (Number.isFinite(quantity) && Number.isFinite(price ?? NaN)) {
        const multiplier = isOptionText ? 100 : 1;
        totalPL = Math.abs(quantity) * (price ?? 0) * multiplier;
      }
    }

    // Handle informational CUSIP rows that often omit amount
    if (totalPL == null) {
      const isCusipRow = /CUSIP/i.test(notes) || /CUSIP/i.test(typeField);
      if (isCusipRow) {
        warnings.push(`Skipped CUSIP detail row with no amount: ${notes || typeRaw || "CUSIP row"}`);
        skipped += 1;
        continue;
      }
    }

    // Handle assignment markers with blank Amount
    if (totalPL == null) {
      if (isAssignment) {
        totalPL = 0;
        warnings.push(`Imported assignment marker with $0 amount: ${notes || typeRaw || "Assignment row"}`);
      } else if (category === "FILL" || isOptionText || isOptionish) {
        warnings.push(`Skipped option row missing amount: ${notes || typeRaw || "Option row"}`);
        skipped += 1;
        continue;
      } else {
        errors.push(`Row missing amount for targeted category: ${notes || typeRaw || "Unknown row"}`);
        continue;
      }
    }

    // Normalize signs
    if (category === "FILL") {
      totalPL = action === "BTO" || action === "BTC" ? -Math.abs(totalPL) : Math.abs(totalPL);
    } else if (category === "DIVIDEND") {
      totalPL = Math.abs(totalPL);
    } else if (category === "INTEREST") {
      totalPL = Math.abs(totalPL);
    } else if (category === "FEE") {
      totalPL = -Math.abs(totalPL);
    } else if (category === "LENDING") {
      totalPL = Math.abs(totalPL);
    } else if (category === "EQUITY") {
      if (/\bBUY\b/.test(typeField)) totalPL = -Math.abs(totalPL);
      if (/\bSELL\b/.test(typeField)) totalPL = Math.abs(totalPL);
    }

    if (category === "FILL") {
      const isAssignRow = isAssignment && isOptionText;
      trades.push({
        ticker,
        type: action || (isAssignRow ? transCode : undefined),
        openDate: action === "STO" || action === "BTO" ? date : undefined,
        closeDate: action === "BTC" || action === "STC" || isAssignRow ? date : undefined,
        totalPL,
        notes: notes || undefined,
        quantity: Number.isFinite(quantity) ? Math.abs(quantity) : undefined,
        price: typeof price === "number" && Number.isFinite(price) ? price : undefined,
      });
    } else {
      const equitySide: "BUY" | "SELL" | undefined =
        category === "EQUITY"
          ? /\bBUY\b/.test(typeField)
            ? "BUY"
            : /\bSELL\b/.test(typeField)
              ? "SELL"
              : undefined
          : undefined;

      cashflows.push({
        date,
        month: monthFromSlash(date),
        category: category as CashflowCategory,
        amount: totalPL,
        ticker,
        notes: notes || undefined,
        rawType: typeRaw || undefined,
        quantity: Number.isFinite(quantity) ? Math.abs(quantity) : undefined,
        price: typeof price === "number" && Number.isFinite(price) ? price : undefined,
        side: equitySide,
      });
    }
  }

  return { trades, cashflows, warnings, errors, skipped };
}

function activityDateForTrade(d: TradeDraft) {
  if (d.type === "STO" || d.type === "BTO") return d.openDate;
  if (d.type === "BTC" || d.type === "STC") return d.closeDate;
  return d.openDate || d.closeDate;
}

function buildRecords(drafts: TradeDraft[]): Trade[] {
  const now = new Date().toISOString();
  return drafts.map((d): Trade => ({
    id:
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `t_${Math.random().toString(36).slice(2)}`,
    createdAt: now,
    updatedAt: now,
    ticker: d.ticker,
    type: d.type,
    openDate: d.openDate,
    closeDate: d.closeDate,
    activityDate: activityDateForTrade(d),
    activityMonth: monthFromSlash(activityDateForTrade(d)),
    totalPL: d.totalPL,
    notes: d.notes,
    status: "OPEN",
    quantity: d.quantity,
    price: d.price,
  }));
}

function buildCashflowRecords(drafts: CashflowDraft[]): Cashflow[] {
  const now = new Date().toISOString();
  return drafts.map((d): Cashflow => ({
    id:
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `c_${Math.random().toString(36).slice(2)}`,
    createdAt: now,
    updatedAt: now,
    date: d.date,
    month: d.month,
    category: d.category,
    amount: d.amount,
    ticker: d.ticker,
    notes: d.notes,
    rawType: d.rawType,

    // NEW
    quantity: d.quantity,
    price: d.price,
    side: d.side,
  }));
}

export default function ImportPage() {
  const [source, setSource] = useState<ImportSource>("csv");
  const [file, setFile] = useState<File | null>(null);
  const [pdfText, setPdfText] = useState("");
  const [lastReport, setLastReport] = useState<ParseResult | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const fileLabel = useMemo(() => file?.name ?? "No file selected", [file]);

  async function handleAppend() {
    setIsSaving(true);
    setStatus(null);
    try {
      const currentSource = source;
      if (
        currentSource === "pdf" &&
        !pdfText.trim() &&
        file &&
        file.name.toLowerCase().endsWith(".pdf")
      ) {
        setStatus("Paste PDF text for strict parsing.");
        setLastReport(null);
        return;
      }

      const text =
        currentSource === "pdf" && pdfText.trim()
          ? pdfText
          : file
            ? await file.text()
            : "";

      if (!text) {
        setStatus("Provide a file or paste statement text.");
        setLastReport(null);
        return;
      }

      const parsed = currentSource === "pdf" ? parsePdfText(text) : parseCsvText(text);
      setLastReport(parsed);

      if (parsed.errors.length) {
        setStatus(`Import blocked: ${parsed.errors.length} error(s). Fix and try again.`);
        return;
      }

      const tradeRecords = buildRecords(parsed.trades);
      const cashflowRecords = buildCashflowRecords(parsed.cashflows);
      if (tradeRecords.length) await db.trades.bulkAdd(tradeRecords);
      if (cashflowRecords.length) await db.cashflows.bulkAdd(cashflowRecords);
      const skipped = parsed.skipped ? `, skipped ${parsed.skipped}` : "";
      setStatus(
        `Import complete: appended ${tradeRecords.length + cashflowRecords.length} rows (${tradeRecords.length} trades, ${cashflowRecords.length} cashflows)${skipped}.`
      );
    } catch (err) {
      setStatus(`Import failed: ${String(err)}`);
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="min-h-screen bg-zinc-50 px-6 py-10 text-zinc-900">
      <div className="mx-auto max-w-3xl space-y-6">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Import</h1>
          <p className="mt-2 text-sm text-zinc-700">
            Append fills, dividends, fees, interest, and equity trades from Robinhood CSV. Strict validation on import.
          </p>
        </div>

        <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm space-y-4">
          <div className="flex flex-wrap gap-2 text-sm">
            <button
              type="button"
              onClick={() => setSource("csv")}
              className={`rounded-xl px-3 py-2 ${source === "csv" ? "bg-zinc-900 text-white" : "border border-zinc-200 text-zinc-700"}`}
            >
              CSV
            </button>
            <button
              type="button"
              onClick={() => setSource("pdf")}
              className={`rounded-xl px-3 py-2 ${source === "pdf" ? "bg-zinc-900 text-white" : "border border-zinc-200 text-zinc-700"}`}
            >
              PDF (beta)
            </button>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-sm font-medium">Attach file</div>
              <div className="mt-1 text-xs text-zinc-700">{fileLabel}</div>
            </div>
            <div>
              <input
                id="import-file"
                type="file"
                accept=".csv,.pdf,.txt,text/csv,application/pdf"
                className="sr-only"
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  setFile(f);
                  setSource(detectSource(f));
                }}
              />
              <label
                htmlFor="import-file"
                className="inline-flex cursor-pointer items-center justify-center rounded-xl border border-zinc-200 bg-white px-4 py-2 text-sm font-medium text-zinc-900 shadow-sm hover:bg-zinc-50"
              >
                Choose file
              </label>
            </div>
          </div>

          {source === "pdf" ? (
            <div>
              <div className="text-sm font-medium">Paste PDF text (required for strict PDF parsing)</div>
              <textarea
                value={pdfText}
                onChange={(e) => setPdfText(e.target.value)}
                rows={6}
                placeholder="Paste Account Activity + Executed Trades Pending Settlement sections here."
                className="mt-2 w-full rounded-xl border border-zinc-200 bg-white p-3 text-sm text-zinc-900 outline-none"
              />
              <div className="mt-2 text-xs text-zinc-700">
                PDF parsing is best-effort. CSV is recommended for accuracy.
              </div>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={handleAppend}
              className="rounded-xl bg-zinc-900 px-4 py-2 text-sm font-medium text-white"
              disabled={isSaving}
            >
              {isSaving ? "Importing..." : "Import & append"}
            </button>
            {status ? <div className="text-xs text-zinc-700">{status}</div> : null}
          </div>
        </div>

        {lastReport ? (
          <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium">Last import</div>
              <div className="text-xs text-zinc-700">
                {lastReport.trades.length + lastReport.cashflows.length} rows
              </div>
            </div>

            {lastReport.errors.length > 0 ? (
              <div className="mt-2 text-xs text-red-700">
                {lastReport.errors.slice(0, 3).map((e, i) => (
                  <div key={i}>• {e}</div>
                ))}
                {lastReport.errors.length > 3 ? <div>• {lastReport.errors.length - 3} more…</div> : null}
              </div>
            ) : null}

            {lastReport.warnings.length > 0 ? (
              <div className="mt-2 text-xs text-zinc-700">
                {lastReport.warnings.slice(0, 3).map((w, i) => (
                  <div key={i}>• {w}</div>
                ))}
                {lastReport.warnings.length > 3 ? <div>• {lastReport.warnings.length - 3} more…</div> : null}
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="text-xs text-zinc-700">
          Import runs strict validation before appending. Fix errors shown in the last import summary.
          Importing the same file twice will duplicate data.
        </div>
      </div>
    </div>
  );
}
