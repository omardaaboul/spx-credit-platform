#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-3000}"
HOST="${HOST:-127.0.0.1}"
ENDPOINT="${ENDPOINT:-/api/spx0dte}"
SERVICE_NAME="${SERVICE_NAME:-spx-dashboard}"

require_jq() {
  if ! command -v jq >/dev/null 2>&1; then
    echo "[ERROR] jq required. Install: sudo apt-get install -y jq"
    exit 2
  fi
}

require_jq

URL="http://${HOST}:${PORT}${ENDPOINT}"
if ! payload="$(curl -sf "${URL}")"; then
  echo "[ERROR] Failed to fetch ${URL}"
  exit 7
fi

jq_assert() {
  local expr="$1"
  local code="$2"
  local msg="$3"
  if ! echo "${payload}" | jq -e "${expr}" >/dev/null; then
    echo "[ERROR] ${msg}"
    exit "${code}"
  fi
}

# Check 1: schema presence
jq_assert '
  has("generatedAtEt")
  and has("generatedAtParis")
  and has("data_mode")
  and (.market | type == "object" and has("isOpen"))
  and (.metrics | type == "object" and has("spx"))
  and (.dataFeeds | type == "object"
      and has("underlying_price")
      and has("option_chain")
      and has("greeks")
      and (.underlying_price | type == "object" and has("timestampIso"))
      and (.option_chain | type == "object" and has("timestampIso"))
      and (.greeks | type == "object" and has("timestampIso")))
  and (.symbolValidation | type == "object"
      and has("targets")
      and has("chain")
      and has("checks")
      and (.chain | type == "object" and has("expirationsPresent")))
' 3 "Missing required snapshot-header/schema keys"

# Check 2: target keys
jq_assert '.symbolValidation.targets | has("2") and has("7") and has("14") and has("30") and has("45")' 4 \
  "symbolValidation.targets must include keys 2/7/14/30/45"

# Gather checks and helpers
checks_all_true_expr='.symbolValidation.checks as $c | ($c.spot_reasonable == true and $c.chain_has_target_expirations == true and $c.greeks_match_chain == true and $c.spot_age_ok == true and $c.chain_age_ok == true and $c.greeks_age_ok == true)'

has_rec_expr='.recommendation.short_strike != null and .recommendation.expiry != null'

# Check 3: READY integrity implication (top-level ready)
if echo "${payload}" | jq -e '.ready == true' >/dev/null; then
  if ! echo "${payload}" | jq -e "${checks_all_true_expr} and (${has_rec_expr})" >/dev/null; then
    echo "[ERROR] READY payload failed integrity implication."
    echo "${payload}" | jq '{ready,reason,data_mode,spx:.metrics.spx,checks:.symbolValidation.checks,recommendation:{short_strike:.recommendation.short_strike,expiry:.recommendation.expiry}}'
    exit 5
  fi
fi

# Check 3b: READY integrity implication (candidate rows)
if echo "${payload}" | jq -e '
  (.candidates // [])
  | any(.ready == true and ((.recommendation.short_strike == null) or (.recommendation.expiry == null)))
' >/dev/null; then
  echo "[ERROR] At least one READY candidate is missing recommendation.short_strike or recommendation.expiry"
  echo "${payload}" | jq '{readyCandidates:[(.candidates // [])[] | select(.ready==true) | {strategy,ready,reason,recommendation}]}'
  exit 5
fi

# Check 4: BLOCKED consistency
if echo "${payload}" | jq -e "(${checks_all_true_expr}) | not" >/dev/null; then
  if echo "${payload}" | jq -e 'has("ready") and has("reason")' >/dev/null; then
    if ! echo "${payload}" | jq -e '(.ready == false) or ((.reason // "") | startswith("BLOCKED:"))' >/dev/null; then
      echo "[ERROR] Integrity checks are false but payload is not blocked/not-ready."
      echo "${payload}" | jq '{ready,reason,data_mode,spx:.metrics.spx,checks:.symbolValidation.checks}'
      exit 6
    fi
  else
    if ! echo "${payload}" | jq -e '
      (.candidates // [])
      | all(.ready != true or ((.reason // "") | startswith("BLOCKED:")))
    ' >/dev/null; then
      echo "[ERROR] Integrity checks are false but at least one READY candidate is not BLOCKED."
      echo "${payload}" | jq '{checks:.symbolValidation.checks,readyCandidates:[(.candidates // [])[] | select(.ready==true) | {strategy,reason}]}'
      exit 6
    fi
  fi
fi

echo "${payload}" | jq '{
  data_mode,
  market_is_open: .market.isOpen,
  spx: .metrics.spx,
  spot_ts: .dataFeeds.underlying_price.timestampIso,
  chain_ts: .dataFeeds.option_chain.timestampIso,
  greeks_ts: .dataFeeds.greeks.timestampIso,
  ready: (.ready // null),
  reason: (.reason // null),
  checks: .symbolValidation.checks
}'

if [[ "${1:-}" == "--logs" ]]; then
  matches="$(sudo journalctl -u "${SERVICE_NAME}" -n 200 --no-pager | grep -i "integrity_block" | wc -l | tr -d ' ')"
  echo "[INFO] integrity_block matches in last 200 logs: ${matches}"
  sudo journalctl -u "${SERVICE_NAME}" -n 200 --no-pager | grep -i "integrity_block" || true
fi

echo "[OK] Verification passed for ${URL}"
