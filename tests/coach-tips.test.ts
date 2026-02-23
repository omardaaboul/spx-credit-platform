import { describe, expect, it } from "vitest";
import { generateCoachTips, type CoachRules, type CoachTrade } from "@/lib/coach-tips";

const baseRules: CoachRules = {
  riskPerTradePercentDefault: 1,
  maxTradesPerDay: 3,
  maxDailyLossPercent: 3,
};

const baseDate = new Date("2024-01-01T10:00:00Z");

const trade = (overrides: Partial<CoachTrade> = {}): CoachTrade => ({
  setupId: "setup-1",
  status: "closed",
  pnlAmount: 100,
  followedPlan: true,
  plannedEntryDate: baseDate,
  enteredAt: baseDate,
  maxRiskPercent: 1,
  ...overrides,
});

describe("generateCoachTips", () => {
  it("adds adherence tip when plan adherence is low", () => {
    const trades = Array.from({ length: 10 }).map((_, i) =>
      trade({ followedPlan: i % 5 === 0 }),
    );

    const tips = generateCoachTips(trades, baseRules);

    expect(tips.some((tip) => tip.title === "Process before P/L")).toBe(true);
  });

  it("adds tightening risk tip when avg loss exceeds avg win with low win rate", () => {
    const trades = [
      trade({ pnlAmount: 100 }),
      trade({ pnlAmount: 120 }),
      trade({ pnlAmount: -250 }),
      trade({ pnlAmount: -200 }),
      trade({ pnlAmount: -180 }),
      trade({ pnlAmount: -300 }),
    ];

    const tips = generateCoachTips(trades, baseRules);

    expect(tips.some((tip) => tip.title === "Risk needs tightening")).toBe(true);
  });

  it("adds cooldown tip when emotional trades are frequent", () => {
    const trades = [
      trade(),
      trade({ emotionalState: "FOMO" }),
      trade({ emotionalState: "angry" }),
      trade(),
      trade(),
      trade({ emotionalState: "revenge" }),
      trade(),
      trade(),
      trade(),
      trade(),
    ];

    const tips = generateCoachTips(trades, baseRules);

    expect(tips.some((tip) => tip.title === "Cooldown after emotional trades")).toBe(true);
  });

  it("flags too many setups in the recent sample", () => {
    const trades = [
      trade({ setupId: "a" }),
      trade({ setupId: "b" }),
      trade({ setupId: "c" }),
      trade({ setupId: "d" }),
      trade({ setupId: "a" }),
      trade({ setupId: "b" }),
      trade({ setupId: "c" }),
      trade({ setupId: "d" }),
    ];

    const tips = generateCoachTips(trades, baseRules);

    expect(tips.some((tip) => tip.title === "Simplify your setup list")).toBe(true);
  });

  it("flags risk overrides above default", () => {
    const trades = [
      trade({ maxRiskPercent: 1.5 }),
      trade({ maxRiskPercent: 1.4 }),
      trade({ maxRiskPercent: 1.6 }),
      trade({ maxRiskPercent: 1.7 }),
      trade({ maxRiskPercent: 1 }),
      trade({ maxRiskPercent: 1 }),
      trade({ maxRiskPercent: 1.8 }),
    ];

    const tips = generateCoachTips(trades, baseRules);

    expect(tips.some((tip) => tip.title === "Stop raising risk")).toBe(true);
  });

  it("flags discretionary exits driven by fear", () => {
    const trades = [
      trade({ exitReason: "discretionary", notes: "Sold early because of fear" }),
      trade({ exitReason: "discretionary", notes: "Nervous and scared" }),
      trade({ exitReason: "target_hit" }),
      trade(),
      trade(),
    ];

    const tips = generateCoachTips(trades, baseRules);

    expect(tips.some((tip) => tip.title === "Define exits to reduce fear")).toBe(true);
  });

  it("flags overtrading when max trades hit on multiple days", () => {
    const trades = [
      trade({ enteredAt: new Date("2024-01-02T10:00:00Z"), plannedEntryDate: new Date("2024-01-02") }),
      trade({ enteredAt: new Date("2024-01-02T11:00:00Z"), plannedEntryDate: new Date("2024-01-02") }),
      trade({ enteredAt: new Date("2024-01-02T12:00:00Z"), plannedEntryDate: new Date("2024-01-02") }),
      trade({ enteredAt: new Date("2024-01-03T10:00:00Z"), plannedEntryDate: new Date("2024-01-03") }),
      trade({ enteredAt: new Date("2024-01-03T11:00:00Z"), plannedEntryDate: new Date("2024-01-03") }),
      trade({ enteredAt: new Date("2024-01-03T12:00:00Z"), plannedEntryDate: new Date("2024-01-03") }),
      trade({ enteredAt: new Date("2024-01-04T10:00:00Z"), plannedEntryDate: new Date("2024-01-04") }),
    ];

    const tips = generateCoachTips(trades, baseRules);

    expect(tips.some((tip) => tip.title === "Overtrading risk")).toBe(true);
  });
});
