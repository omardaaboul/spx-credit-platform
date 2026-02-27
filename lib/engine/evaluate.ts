import { createHash } from "node:crypto";
import type {
  DecisionCode,
  DecisionInput,
  DecisionOutput,
  DecisionReason,
  DecisionStageResult,
  DecisionStatus,
  DteBucketResolution,
} from "@/lib/contracts/decision";
import type { CandidateCard, ChecklistItem } from "@/lib/spx0dte";
import { parseDteFromStrategy, resolveNearestDteBuckets } from "@/lib/engine/dte";
import { rankCandidatesDeterministic } from "@/lib/engine/ranker";
import { classifyVolRegime } from "@/lib/volatility/volRegime";
import { detectVolShock } from "@/lib/volatility/volShock";
import { applyVolPolicy } from "@/lib/policy/volPolicy";
import { expectedMove1Sd } from "@/lib/engine/math";

function runId(input: DecisionInput): string {
  const seed = [input.asOfIso, input.source, input.dataMode, input.session, String(input.candidates.length)].join("|");
  return `dec_${createHash("sha1").update(seed).digest("hex").slice(0, 12)}`;
}

function reason(code: DecisionCode, message: string, details?: Record<string, unknown>): DecisionReason {
  return { code, message, details };
}

function preflightStage(input: DecisionInput): {
  stage: DecisionStageResult;
  blocked: boolean;
  degraded: boolean;
  blocks: DecisionReason[];
  warnings: DecisionReason[];
} {
  const blocks: DecisionReason[] = [];
  const warnings: DecisionReason[] = [];
  let degraded = false;

  if (input.session === "CLOSED" && !input.simulationMode) {
    blocks.push(reason("MARKET_CLOSED", "Market is closed and simulation mode is disabled."));
  }
  if (input.simulationMode) {
    warnings.push(reason("SIMULATION_ACTIVE", "Simulation mode is active. Evaluation uses non-live session policy."));
  }

  const staleSpot =
    input.freshnessAges.spot == null ||
    input.freshnessAges.spot > input.freshnessPolicy.spot_max_age_s * 1000;
  const staleChain =
    input.freshnessAges.chain == null ||
    input.freshnessAges.chain > input.freshnessPolicy.chain_max_age_s * 1000;
  const staleGreeks =
    input.freshnessAges.greeks == null ||
    input.freshnessAges.greeks > input.freshnessPolicy.greeks_max_age_s * 1000;

  if (staleSpot || staleChain || staleGreeks) {
    degraded = true;
    const staleDetails = {
      ages_ms: input.freshnessAges,
      policy_s: input.freshnessPolicy,
    };
    if (staleSpot) warnings.push(reason("SPOT_STALE", "Spot feed is stale or missing.", staleDetails));
    if (staleChain) warnings.push(reason("CHAIN_STALE", "Option chain feed is stale or missing.", staleDetails));
    if (staleGreeks) warnings.push(reason("GREEKS_STALE", "Greeks feed is stale or missing.", staleDetails));

    const shouldBlock =
      (input.decisionMode === "PROBABILISTIC" || input.strictLiveBlocks) &&
      input.dataMode === "LIVE" &&
      input.session === "OPEN" &&
      !input.simulationMode;
    if (shouldBlock) {
      if (staleSpot) blocks.push(reason("DATA_STALE_SPOT", "Spot feed is stale or missing.", staleDetails));
      if (staleChain) blocks.push(reason("DATA_STALE_CHAIN", "Option chain feed is stale or missing.", staleDetails));
      if (staleGreeks) blocks.push(reason("DATA_STALE_GREEKS", "Greeks feed is stale or missing.", staleDetails));
      if (blocks.length === 0) {
        blocks.push(reason("DATA_INCOMPLETE", "Freshness SLA breached in strict live mode.", staleDetails));
      }
    }
  }

  return {
    stage: {
      stage: "preflight",
      status: blocks.length > 0 ? "BLOCK" : "PASS",
      reasons: [...blocks, ...warnings],
      details: {
        session: input.session,
        simulationMode: input.simulationMode,
        dataMode: input.dataMode,
      },
    },
    blocked: blocks.length > 0,
    degraded,
    blocks,
    warnings,
  };
}

function volatilityStage(input: DecisionInput): {
  stage: DecisionStageResult;
  blocks: DecisionReason[];
  warnings: DecisionReason[];
  vol: DecisionOutput["vol"];
  debug: DecisionOutput["debug"]["vol"];
} {
  const volResult = classifyVolRegime({
    asOfIso: input.asOfIso,
    dataMode: input.dataMode,
    spot: input.vol.spot,
    iv_atm: input.vol.iv_atm,
    iv_term: input.vol.iv_term,
    realized_range_proxy: input.vol.realized_range_proxy,
    vix: input.vol.vix,
    iv_history_samples: input.vol.samples,
    freshnessAges: input.vol.freshnessAges,
  });
  const policy = applyVolPolicy(volResult.regime);
  const em1sd = expectedMove1Sd(
    Number(input.vol.spot ?? Number.NaN),
    Number(input.vol.iv_atm ?? Number.NaN),
    Math.max(1, Math.round((input.multiDteTargets[0]?.selected_dte as number | undefined) ?? 7)),
  );
  const shock = detectVolShock({
    spot: input.vol.spot,
    prevSpot: input.vol.prevSpot ?? null,
    em1sd: Number.isFinite(em1sd) ? em1sd : null,
    vix: input.vol.vix ?? null,
    prevVix: input.vol.prevVix ?? null,
  });

  const warnings: DecisionReason[] = [];
  const blocks: DecisionReason[] = [];

  if (volResult.regime === "UNKNOWN") {
    warnings.push(
      reason("VOL_REGIME_UNKNOWN", "Volatility regime is unknown due to missing/stale inputs.", {
        missing_inputs: volResult.missingInputs,
      }),
    );
  }
  if (volResult.sampleCount < Number(process.env.VOL_MIN_SAMPLES ?? 20)) {
    warnings.push(
      reason("VOL_CACHE_INSUFFICIENT", "IV cache has insufficient samples for robust percentile classification.", {
        sample_count: volResult.sampleCount,
        min_samples: Number(process.env.VOL_MIN_SAMPLES ?? 20),
      }),
    );
  }

  if (shock.shockFlag) {
    const strictBlock = input.strictLiveBlocks && input.dataMode === "LIVE" && input.session === "OPEN" && !input.simulationMode;
    if (strictBlock) {
      blocks.push(reason("VOL_SHOCK", "Volatility shock detected; strict live policy blocks new entries.", shock.details));
    } else {
      warnings.push(
        reason("VOL_SHOCK_WARN", "Volatility shock detected; entries are not hard-blocked in current mode.", shock.details),
      );
    }
  }

  for (const note of policy.notes) {
    warnings.push(
      reason(note.code, note.message, note.details),
    );
  }

  const stageReasons = [...blocks, ...warnings];
  return {
    stage: {
      stage: "volatility_regime",
      status: blocks.length > 0 ? "BLOCK" : "PASS",
      reasons: stageReasons,
      details: {
        regime: volResult.regime,
        confidence: volResult.features.confidence,
        policy_allowed_buckets: policy.allowedDteBuckets,
        sample_count: volResult.sampleCount,
      },
    },
    blocks,
    warnings,
    vol: {
      regime: volResult.regime,
      confidence: volResult.features.confidence,
      features: {
        ...volResult.features,
        shockFlag: shock.shockFlag,
      },
      warnings: volResult.warnings,
      shock,
      policy,
    },
    debug: {
      inputsUsed: {
        spot: input.vol.spot,
        iv_atm: input.vol.iv_atm,
        iv_term_keys: Object.keys(input.vol.iv_term ?? {}),
        realized_range_proxy: input.vol.realized_range_proxy ?? null,
        vix: input.vol.vix ?? null,
      },
      missingInputs: volResult.missingInputs,
      lookbackDays: volResult.lookbackDays,
      sampleCount: volResult.sampleCount,
      thresholdsApplied: {
        volLookbackDays: Number(process.env.VOL_LOOKBACK_DAYS ?? 60),
        volMinSamples: Number(process.env.VOL_MIN_SAMPLES ?? 20),
        shockMovePctEm1Sd: Number(process.env.SHOCK_MOVE_PCT_EM1SD ?? 0.35),
        shockVixJump: Number(process.env.SHOCK_VIX_JUMP ?? 2.0),
      },
      regime: volResult.regime,
      confidence: volResult.features.confidence,
      shockFlag: shock.shockFlag,
    },
  };
}

function resolveDteBuckets(input: DecisionInput): { stage: DecisionStageResult; rows: DteBucketResolution[]; reasonRows: DecisionReason[] } {
  const selectedDtes = input.multiDteTargets
    .map((target) => Number(target.selected_dte))
    .filter((value) => Number.isFinite(value) && value > 0)
    .map((value) => Math.round(value));
  const resolved = resolveNearestDteBuckets(selectedDtes, [2, 7, 14, 30, 45]).map((row) => {
    const target = input.multiDteTargets.find((t) => Number(t.target_dte) === row.targetDte);
    return {
      targetDte: row.targetDte,
      selectedDte: row.selectedDte,
      distance: row.distance,
      expiration:
        typeof target?.expiration === "string" && target.expiration.trim().length > 0
          ? target.expiration
          : typeof target?.recommendation?.expiry === "string"
            ? target.recommendation.expiry
            : null,
    } satisfies DteBucketResolution;
  });

  const missing = resolved.filter((row) => row.selectedDte == null);
  const reasons =
    missing.length > 0
      ? [
          reason("MISSING_EXPIRY_FOR_BUCKET", "Missing nearest expiration for one or more target DTE buckets.", {
            missing_targets: missing.map((row) => row.targetDte),
          }),
        ]
      : [];

  return {
    stage: {
      stage: "dte_bucket_resolver",
      status: missing.length > 0 ? "NO_CANDIDATE" : "PASS",
      reasons,
      details: {
        rows: resolved,
      },
    },
    rows: resolved,
    reasonRows: reasons,
  };
}

function regimeStage(input: DecisionInput): { stage: DecisionStageResult; reasonRows: DecisionReason[] } {
  const regime = String(input.regime ?? "").toUpperCase();
  if (!regime || regime === "UNCLASSIFIED" || regime === "NONE") {
    const reasons = [reason("REGIME_UNCLASSIFIED", "Regime classifier did not produce a directional regime.")];
    return {
      stage: {
        stage: "regime_classifier",
        status: input.decisionMode === "PROBABILISTIC" ? "PASS" : "NO_CANDIDATE",
        reasons,
      },
      reasonRows: reasons,
    };
  }
  return {
    stage: {
      stage: "regime_classifier",
      status: "PASS",
      reasons: [],
      details: { regime },
    },
    reasonRows: [],
  };
}

function normalizeChecklistRows(candidate: CandidateCard): ChecklistItem[] {
  const strategyRows = candidate.checklist?.strategy ?? [];
  const globalRows = candidate.checklist?.global ?? [];
  const regimeRows = candidate.checklist?.regime ?? [];
  return [...globalRows, ...regimeRows, ...strategyRows];
}

function candidateReasonCode(candidate: CandidateCard): DecisionCode {
  const reasonText = String(candidate.reason ?? "").toLowerCase();
  if (reasonText.includes("cooldown")) return "ALERT_COOLDOWN_ACTIVE";
  if (reasonText.includes("day cap") || reasonText.includes("daily cap")) return "ALERT_DAY_CAP_REACHED";
  if (reasonText.includes("debounce")) return "CANDIDATE_READY_DEBOUNCED";
  return "HARD_GATES_NOT_MET";
}

function strategyCandidateStage(input: DecisionInput): {
  stage: DecisionStageResult;
  generated: CandidateCard[];
  blockedReasons: DecisionReason[];
  softWarnings: DecisionReason[];
} {
  const allowedDteBuckets = input.volPolicy?.allowedDteBuckets ?? [2, 7, 14, 30, 45];
  const candidatePool = input.candidates.filter((candidate) => {
    const dte = parseDteFromStrategy(candidate.strategy);
    if (!input.feature0dte && (dte == null || dte < 2)) return false;
    return /credit spread|directional spread/i.test(candidate.strategy);
  });

  if (candidatePool.length === 0) {
    const reasons = [
      reason(
        input.feature0dte ? "NO_CREDIT_SPREAD_CANDIDATE" : "FEATURE_0DTE_DISABLED",
        input.feature0dte
          ? "No credit spread candidates generated for this cycle."
          : "0DTE strategies are disabled by feature flag; no multi-DTE candidate found.",
      ),
    ];
    return {
      stage: {
        stage: "candidate_generator",
        status: "NO_CANDIDATE",
        reasons,
      },
      generated: [],
      blockedReasons: reasons,
      softWarnings: [],
    };
  }

  const passed: CandidateCard[] = [];
  const blockedReasons: DecisionReason[] = [];
  const softWarnings: DecisionReason[] = [];

  for (const candidate of candidatePool) {
    const inProbMode = input.decisionMode === "PROBABILISTIC";
    const dte = parseDteFromStrategy(candidate.strategy);
    if (dte != null && dte >= 2) {
      const targetRow = input.multiDteTargets.find(
        (row) => Number(row.target_dte) === dte || row.strategy_label === candidate.strategy,
      );
      const selected = targetRow ? Number(targetRow.selected_dte) : Number.NaN;
      if (!Number.isFinite(selected) || selected <= 0) {
        blockedReasons.push(
          reason("MISSING_EXPIRY_FOR_BUCKET", `Candidate blocked: ${candidate.strategy}`, {
            candidate_id: candidate.candidateId ?? null,
            target_dte: dte,
          }),
        );
        continue;
      }
    }
    if (dte != null && dte >= 2 && !allowedDteBuckets.includes(dte)) {
      if (inProbMode) {
        softWarnings.push(
          reason("VOL_POLICY_BUCKET_DISABLED", `Volatility policy disabled bucket: ${candidate.strategy}`, {
            candidate_id: candidate.candidateId ?? null,
            dte,
            allowed_buckets: allowedDteBuckets,
          }),
        );
      } else {
        blockedReasons.push(
          reason("VOL_POLICY_BUCKET_DISABLED", `Candidate blocked by volatility policy: ${candidate.strategy}`, {
            candidate_id: candidate.candidateId ?? null,
            dte,
            allowed_buckets: allowedDteBuckets,
          }),
        );
        continue;
      }
    }
    if (candidate.hardBlockCode === "INVALID_SPREAD_GEOMETRY") {
      blockedReasons.push(
        reason("INVALID_SPREAD_GEOMETRY", `Candidate blocked: ${candidate.strategy}`, {
          candidate_id: candidate.candidateId ?? null,
          reason: candidate.hardBlockReason ?? "Invalid spread geometry",
        }),
      );
      continue;
    }
    const checklistRows = normalizeChecklistRows(candidate);
    const requiredFailed = checklistRows.filter((row) => row.required !== false && (row.status === "fail" || row.status === "blocked"));
    const optionalFailed = checklistRows.filter((row) => row.required === false && (row.status === "fail" || row.status === "blocked"));

    if (inProbMode) {
      passed.push(candidate);
      for (const row of requiredFailed) {
        const name = String(row.name ?? "").toLowerCase();
        const code =
          name.includes("delta") ? "DELTA_OUT_OF_BAND" :
          name.includes("sd") ? "SD_MULTIPLE_LOW" :
          name.includes("measured move") ? "MMC_GATE_FAIL" :
          name.includes("support/resistance") ? "SR_BUFFER_THIN" :
          name.includes("trend") ? "TREND_MISMATCH" :
          name.includes("credit") ? "LOW_CREDIT_EFFICIENCY" :
          "HARD_GATES_NOT_MET";
        softWarnings.push(
          reason(code, `Soft warning for ${candidate.strategy}: ${row.name}`, {
            detail: row.detail ?? null,
          }),
        );
      }
    } else {
      if (candidate.ready && requiredFailed.length === 0) {
        passed.push(candidate);
      } else {
        blockedReasons.push(
          reason(candidateReasonCode(candidate), `Candidate blocked: ${candidate.strategy}`, {
            candidate_id: candidate.candidateId ?? null,
            reason: candidate.reason,
            required_failed: requiredFailed.map((row) => row.name),
          }),
        );
      }
    }

    for (const row of optionalFailed) {
      const name = String(row.name ?? "").toLowerCase();
      softWarnings.push(
        reason(
          name.includes("liquidity") ? "SOFT_LIQUIDITY_WARNING" : "SOFT_SLIPPAGE_WARNING",
          `Soft warning for ${candidate.strategy}: ${row.name}`,
          { detail: row.detail ?? null },
        ),
      );
    }
  }

  return {
    stage: {
      stage: "candidate_generator",
      status: passed.length > 0 ? "PASS" : "BLOCK",
      reasons: passed.length > 0 ? [] : blockedReasons.slice(0, 3),
      details: {
        total_pool: candidatePool.length,
        passed: passed.length,
      },
    },
    generated: passed,
    blockedReasons,
    softWarnings,
  };
}

function alertPolicyStage(input: DecisionInput): { stage: DecisionStageResult; warningRows: DecisionReason[] } {
  const warningRows: DecisionReason[] = [];
  if (input.simulationMode && !input.allowSimAlerts) {
    warningRows.push(
      reason("ALERTS_SUPPRESSED_SIMULATION", "Simulation mode is active; outbound alerts are suppressed."),
    );
  }

  const cooldownHints = input.alerts.filter((alert) =>
    /cooldown|day cap|dedupe|debounce/i.test(String(alert.reason ?? "")),
  );
  for (const alert of cooldownHints) {
    const lower = String(alert.reason).toLowerCase();
    const code: DecisionCode = lower.includes("dedupe")
      ? "ALERT_DEDUPED"
      : lower.includes("day cap")
        ? "ALERT_DAY_CAP_REACHED"
        : lower.includes("debounce")
          ? "CANDIDATE_READY_DEBOUNCED"
          : "ALERT_COOLDOWN_ACTIVE";
    warningRows.push(reason(code, `Alert policy note: ${alert.strategy} - ${alert.reason}`));
  }

  return {
    stage: {
      stage: "alert_policy",
      status: "PASS",
      reasons: warningRows,
    },
    warningRows,
  };
}

export function evaluateDecision(input: DecisionInput): DecisionOutput {
  const run = runId(input);
  const stages: DecisionStageResult[] = [];

  const preflight = preflightStage(input);
  stages.push(preflight.stage);

  const volStage = volatilityStage(input);
  stages.push(volStage.stage);

  const stagedInput: DecisionInput = {
    ...input,
    volPolicy: volStage.vol.policy,
  };

  const dteBuckets = resolveDteBuckets(stagedInput);
  stages.push(dteBuckets.stage);

  const regime = regimeStage(stagedInput);
  stages.push(regime.stage);

  const candidatesStage = strategyCandidateStage(stagedInput);
  stages.push(candidatesStage.stage);

  const softStage: DecisionStageResult = {
    stage: "soft_warnings",
    status: "PASS",
    reasons: candidatesStage.softWarnings,
  };
  stages.push(softStage);

  const ranked = rankCandidatesDeterministic(candidatesStage.generated, input.decisionMode, {
    applyGammaPenalty: String(process.env.PROB_MAX_GAMMA_PENALTY ?? "true").toLowerCase() !== "false",
  });
  const rankStage: DecisionStageResult = {
    stage: "deterministic_ranker",
    status: ranked.length > 0 ? "PASS" : "NO_CANDIDATE",
    reasons: ranked.length > 0 ? [] : [reason("NO_CREDIT_SPREAD_CANDIDATE", "No candidates survived hard gates.")],
    details: {
      ranked: ranked.map((row) => ({
        candidateId: row.candidateId,
        strategy: row.strategy,
        score: row.score,
      })),
    },
  };
  stages.push(rankStage);

  const alertPolicy = alertPolicyStage(input);
  stages.push(alertPolicy.stage);

  const blocks: DecisionReason[] = [
    ...preflight.blocks,
    ...volStage.blocks,
    ...dteBuckets.reasonRows.filter((r) => r.code === "MISSING_EXPIRY_FOR_BUCKET"),
    ...regime.reasonRows.filter((r) => r.code === "REGIME_UNCLASSIFIED"),
    ...candidatesStage.blockedReasons,
  ];
  const warnings: DecisionReason[] = [
    ...preflight.warnings,
    ...volStage.warnings,
    ...candidatesStage.softWarnings,
    ...alertPolicy.warningRows,
  ];

  let status: DecisionStatus = "NO_CANDIDATE";
  if (preflight.blocked) {
    status = "BLOCKED";
  } else if (ranked.length > 0 && !preflight.degraded) {
    status = "READY";
  } else if (preflight.degraded) {
    status = blocks.length > 0 ? "BLOCKED" : "DEGRADED";
  } else if (blocks.length > 0) {
    status = "BLOCKED";
  } else {
    status = "NO_CANDIDATE";
  }

  return {
    status,
    decisionMode: input.decisionMode,
    blocks,
    warnings,
    vol: volStage.vol,
    candidates: candidatesStage.generated,
    ranked,
    primaryCandidateId: ranked[0]?.candidateId ?? null,
    dteBuckets: dteBuckets.rows,
    debug: {
      runId: run,
      asOfIso: input.asOfIso,
      source: input.source,
      dataMode: input.dataMode,
      decisionMode: input.decisionMode,
      freshnessAges: input.freshnessAges,
      freshnessPolicy: input.freshnessPolicy,
      session: input.session,
      simulationMode: input.simulationMode,
      strictLiveBlocks: input.strictLiveBlocks,
      feature0dte: input.feature0dte,
      vol: volStage.debug,
      stages,
    },
  };
}
