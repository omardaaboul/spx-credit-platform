// lib/db.ts
import Dexie, { Table } from "dexie";

export type TradeStatus = "OPEN" | "CLOSED" | "INCOMPLETE";

export type Trade = {
  id: string;
  createdAt: string;
  updatedAt: string;

  ticker: string;
  type?: string;         // STO/BTC/BTO/STC/OASGN etc.
  openDate?: string;     // YYYY-MM-DD
  closeDate?: string;    // YYYY-MM-DD
  activityDate?: string; // YYYY-MM-DD
  activityMonth?: string;// YYYY-MM

  quantity?: number;      // shares/contracts
  price?: number;         // execution price
  side?: "BUY" | "SELL";  // only meaningful for EQUITY rows

  totalPL?: number;      // signed cashflow
  notes?: string;

  status: TradeStatus;
};

export type CashflowCategory =
  | "DIVIDEND"
  | "INTEREST"
  | "FEE"
  | "LENDING"
  | "SWEEP"
  | "TRANSFER"
  | "EQUITY"
  | "OTHER";

export type Cashflow = {
  id: string;
  createdAt: string;
  updatedAt: string;

  date: string;          // YYYY-MM-DD
  month: string;         // YYYY-MM
  category: CashflowCategory;
  amount: number;
  ticker?: string;
  notes?: string;
  rawType?: string;

  quantity?: number;
  price?: number;
  side?: "BUY" | "SELL";
};

export class AppDB extends Dexie {
  trades!: Table<Trade, string>;
  cashflows!: Table<Cashflow, string>;

  constructor() {
    super("optionslog");

    // v2 adds `quantity`
    this.version(1).stores({
      trades: "id, ticker, type, openDate, closeDate, activityDate, activityMonth",
      cashflows: "id, date, month, category, ticker",
    });

    this.version(2).stores({
      trades: "id, ticker, type, openDate, closeDate, activityDate, activityMonth, quantity",
      cashflows: "id, date, month, category, ticker",
    });
  }
}

export const db = new AppDB();
