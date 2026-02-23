-- CreateTable
CREATE TABLE "Setup" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "entryCriteria" TEXT NOT NULL,
    "exitCriteria" TEXT NOT NULL,
    "bestMarketConditions" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Trade" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "setupId" TEXT,
    "symbol" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "strategyDetails" TEXT NOT NULL,
    "plannedEntryDate" DATETIME NOT NULL,
    "enteredAt" DATETIME,
    "closedAt" DATETIME,
    "status" TEXT NOT NULL,
    "accountValueAtEntry" REAL,
    "maxRiskAmount" REAL NOT NULL,
    "maxRiskPercent" REAL NOT NULL,
    "positionSizeContracts" INTEGER,
    "thesis" TEXT NOT NULL,
    "catalystsOrContext" TEXT NOT NULL,
    "ivContext" TEXT NOT NULL,
    "invalidationLevel" TEXT NOT NULL,
    "takeProfitPlan" TEXT NOT NULL,
    "stopLossPlan" TEXT NOT NULL,
    "timeStopPlan" TEXT NOT NULL,
    "confidenceScore" INTEGER NOT NULL,
    "checklistCompleted" BOOLEAN NOT NULL,
    "exitReason" TEXT,
    "pnlAmount" REAL,
    "pnlPercent" REAL,
    "notes" TEXT,
    "emotionalState" TEXT,
    "followedPlan" BOOLEAN,
    "mistakes" TEXT,
    "lessons" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Trade_setupId_fkey" FOREIGN KEY ("setupId") REFERENCES "Setup" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Rule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "riskPerTradePercentDefault" REAL NOT NULL,
    "maxDailyLossPercent" REAL NOT NULL,
    "maxTradesPerDay" INTEGER NOT NULL,
    "requireChecklistBeforeEntry" BOOLEAN NOT NULL,
    "requireMaxLossDefined" BOOLEAN NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Journal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "date" DATETIME NOT NULL,
    "preMarketNotes" TEXT,
    "postMarketNotes" TEXT,
    "mood" TEXT,
    "adherenceScore" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "Trade_status_idx" ON "Trade"("status");

-- CreateIndex
CREATE INDEX "Trade_plannedEntryDate_idx" ON "Trade"("plannedEntryDate");

-- CreateIndex
CREATE INDEX "Trade_enteredAt_idx" ON "Trade"("enteredAt");

-- CreateIndex
CREATE INDEX "Trade_closedAt_idx" ON "Trade"("closedAt");
