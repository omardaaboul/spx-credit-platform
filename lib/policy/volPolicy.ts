import type { VolRegime } from "@/lib/volatility/volRegime";

export type VolBucketAdjustment = {
  deltaBandShift: number;
  minSdMultipleDelta: number;
  minCreditPctDelta: number;
  widthMinDelta: number;
  widthMaxDelta: number;
};

export type VolPolicyConfig = {
  extremeBlockAll: boolean;
  expandingAllow2Dte: boolean;
};

export type VolPolicyResult = {
  allowedDteBuckets: number[];
  perBucketAdjustments: Record<number, VolBucketAdjustment>;
  notes: Array<{ code: "VOL_POLICY_BUCKET_DISABLED"; message: string; details?: Record<string, unknown> }>;
};

function defaults(): VolPolicyConfig {
  return {
    extremeBlockAll: String(process.env.VOL_POLICY_EXTREME_BLOCK_ALL ?? "false").toLowerCase() === "true",
    expandingAllow2Dte: String(process.env.VOL_POLICY_EXPANDING_ALLOW_2DTE ?? "false").toLowerCase() === "true",
  };
}

function baseAdjustments(): Record<number, VolBucketAdjustment> {
  return {
    2: { deltaBandShift: 0, minSdMultipleDelta: 0, minCreditPctDelta: 0, widthMinDelta: 0, widthMaxDelta: 0 },
    7: { deltaBandShift: 0, minSdMultipleDelta: 0, minCreditPctDelta: 0, widthMinDelta: 0, widthMaxDelta: 0 },
    14: { deltaBandShift: 0, minSdMultipleDelta: 0, minCreditPctDelta: 0, widthMinDelta: 0, widthMaxDelta: 0 },
    30: { deltaBandShift: 0, minSdMultipleDelta: 0, minCreditPctDelta: 0, widthMinDelta: 0, widthMaxDelta: 0 },
    45: { deltaBandShift: 0, minSdMultipleDelta: 0, minCreditPctDelta: 0, widthMinDelta: 0, widthMaxDelta: 0 },
  };
}

export function applyVolPolicy(regime: VolRegime, cfg: Partial<VolPolicyConfig> = {}): VolPolicyResult {
  const config = { ...defaults(), ...cfg };
  const adjustments = baseAdjustments();
  const notes: VolPolicyResult["notes"] = [];
  let allowed = [2, 7, 14, 30, 45];

  if (regime === "VOL_SUPPRESSED") {
    allowed = [2, 7, 14, 30];
    adjustments[2] = { ...adjustments[2], deltaBandShift: -0.01, minSdMultipleDelta: 0.1, minCreditPctDelta: 0.01 };
    adjustments[7] = { ...adjustments[7], minSdMultipleDelta: 0.05 };
    notes.push({
      code: "VOL_POLICY_BUCKET_DISABLED",
      message: "45-DTE bucket de-prioritized in suppressed volatility regime.",
      details: { regime, disabled: [45] },
    });
  } else if (regime === "VOL_EXPANDING") {
    allowed = config.expandingAllow2Dte ? [2, 7, 14, 30, 45] : [7, 14, 30, 45];
    adjustments[7] = { ...adjustments[7], minSdMultipleDelta: 0.1 };
    adjustments[14] = { ...adjustments[14], minSdMultipleDelta: 0.1 };
    adjustments[30] = { ...adjustments[30], minSdMultipleDelta: 0.1 };
    if (!config.expandingAllow2Dte) {
      notes.push({
        code: "VOL_POLICY_BUCKET_DISABLED",
        message: "2-DTE bucket disabled in expanding volatility regime.",
        details: { regime, disabled: [2] },
      });
    }
  } else if (regime === "VOL_EXTREME") {
    allowed = config.extremeBlockAll ? [] : [30, 45];
    adjustments[30] = { ...adjustments[30], minSdMultipleDelta: 0.2, minCreditPctDelta: 0.02 };
    adjustments[45] = { ...adjustments[45], minSdMultipleDelta: 0.2, minCreditPctDelta: 0.02 };
    notes.push({
      code: "VOL_POLICY_BUCKET_DISABLED",
      message: config.extremeBlockAll
        ? "All DTE buckets disabled in extreme volatility regime."
        : "Only 30-DTE and 45-DTE buckets allowed in extreme volatility regime.",
      details: { regime, allowed },
    });
  }

  return {
    allowedDteBuckets: allowed,
    perBucketAdjustments: adjustments,
    notes,
  };
}

