// Pure, deterministic forecasting strategies. No network, no secrets, no side
// effects — unit-tested in test/strategy.test.js.
//
// Design note: AIProve scores forecasts on Brier (yes/no) and absolute error
// (single number). A confident wrong call costs more than a hedged one, so
// both strategies are deliberately hedged: probabilities are clamped to
// [0.35, 0.65] and price forecasts are damped toward the last close.

function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

/**
 * BTC 7-day direction forecast.
 * @param {number[]} dailyCloses ascending daily closes, oldest first (>= 8).
 * @returns {{answer: 'yes'|'no', confidence: number, detail: object}}
 *   confidence is P(BTC closes higher in 7 days), clamped to [0.35, 0.65].
 *   answer is 'yes' when confidence >= 0.5, else 'no'.
 */
function btcDirectionForecast(dailyCloses) {
  if (!Array.isArray(dailyCloses) || dailyCloses.length < 8) {
    throw new Error('btcDirectionForecast needs >= 8 daily closes');
  }
  const last = dailyCloses[dailyCloses.length - 1];
  const r7 = last / dailyCloses[dailyCloses.length - 8] - 1;
  const r3 = last / dailyCloses[dailyCloses.length - 4] - 1;
  const r1 = last / dailyCloses[dailyCloses.length - 2] - 1;
  // Weighted momentum: longer windows weigh more; all three agree in a trend.
  const momentum = 0.5 * r7 + 0.3 * r3 + 0.2 * r1;
  // 10% weighted momentum moves the probability by the full 15 points.
  const pYes = 0.5 + clamp(momentum / 0.10, -1, 1) * 0.15;
  const confidence = Math.round(clamp(pYes, 0.35, 0.65) * 10000) / 10000;
  return {
    answer: confidence >= 0.5 ? 'yes' : 'no',
    confidence,
    detail: {
      lastClose: last,
      return7d: Math.round(r7 * 10000) / 10000,
      return3d: Math.round(r3 * 10000) / 10000,
      return1d: Math.round(r1 * 10000) / 10000,
      weightedMomentum: Math.round(momentum * 10000) / 10000,
    },
  };
}

/**
 * NVDA close 3 trading days out.
 * @param {number[]} dailyCloses ascending daily closes (>= 4).
 * @returns {{forecast: number, detail: object}}
 *   Damped momentum: last close * (1 + 0.25 * 3d return), move clamped to ±5%.
 */
function nvdaCloseForecast(dailyCloses) {
  if (!Array.isArray(dailyCloses) || dailyCloses.length < 4) {
    throw new Error('nvdaCloseForecast needs >= 4 daily closes');
  }
  const last = dailyCloses[dailyCloses.length - 1];
  const r3 = last / dailyCloses[dailyCloses.length - 4] - 1;
  const move = clamp(0.25 * r3, -0.05, 0.05);
  const forecast = Math.round(last * (1 + move) * 100) / 100;
  return {
    forecast,
    detail: {
      lastClose: last,
      return3d: Math.round(r3 * 10000) / 10000,
      dampedMove: Math.round(move * 10000) / 10000,
    },
  };
}

module.exports = { btcDirectionForecast, nvdaCloseForecast, clamp };
