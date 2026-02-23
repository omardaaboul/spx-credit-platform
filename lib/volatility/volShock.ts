export type VolShockSeverity = "none" | "warn" | "block";

export type VolShockInput = {
  spot: number | null;
  prevSpot: number | null;
  em1sd: number | null;
  vix: number | null;
  prevVix: number | null;
};

export type VolShockConfig = {
  movePctEm1Sd: number;
  vixJump: number;
};

export type VolShockResult = {
  shockFlag: boolean;
  severity: VolShockSeverity;
  reasonCode: "VOL_SHOCK" | "VOL_SHOCK_WARN" | null;
  details: {
    movePctEm1Sd: number | null;
    vixDelta: number | null;
    thresholdMovePctEm1Sd: number;
    thresholdVixJump: number;
  };
};

function finite(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function configDefaults(): VolShockConfig {
  return {
    movePctEm1Sd: Number(process.env.SHOCK_MOVE_PCT_EM1SD ?? 0.35),
    vixJump: Number(process.env.SHOCK_VIX_JUMP ?? 2.0),
  };
}

export function detectVolShock(input: VolShockInput, cfg: Partial<VolShockConfig> = {}): VolShockResult {
  const config = { ...configDefaults(), ...cfg };
  const spot = finite(input.spot);
  const prevSpot = finite(input.prevSpot);
  const em = finite(input.em1sd);
  const vix = finite(input.vix);
  const prevVix = finite(input.prevVix);

  const movePctEm1Sd =
    spot != null && prevSpot != null && em != null && em > 0 ? Math.abs(spot - prevSpot) / em : null;
  const vixDelta = vix != null && prevVix != null ? vix - prevVix : null;

  const moveShock = movePctEm1Sd != null && movePctEm1Sd >= config.movePctEm1Sd;
  const vixShock = vixDelta != null && vixDelta >= config.vixJump;
  const shockFlag = moveShock || vixShock;

  let severity: VolShockSeverity = "none";
  if (shockFlag) {
    const extremeMove = movePctEm1Sd != null && movePctEm1Sd >= config.movePctEm1Sd * 1.5;
    const extremeVix = vixDelta != null && vixDelta >= config.vixJump * 1.5;
    severity = extremeMove || extremeVix ? "block" : "warn";
  }

  return {
    shockFlag,
    severity,
    reasonCode: !shockFlag ? null : severity === "block" ? "VOL_SHOCK" : "VOL_SHOCK_WARN",
    details: {
      movePctEm1Sd: movePctEm1Sd == null ? null : Number(movePctEm1Sd.toFixed(4)),
      vixDelta: vixDelta == null ? null : Number(vixDelta.toFixed(4)),
      thresholdMovePctEm1Sd: config.movePctEm1Sd,
      thresholdVixJump: config.vixJump,
    },
  };
}

