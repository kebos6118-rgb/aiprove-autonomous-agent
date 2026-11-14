const assert = require('node:assert');
const test = require('node:test');
const { btcDirectionForecast, nvdaCloseForecast } = require('../src/strategy');

test('btc: strong downtrend -> no, hedged at the 0.35 floor', () => {
  // 77.5k -> 65.4k over 14 days (real shape, 2026-11-14).
  const closes = [77520, 78293, 76709, 77384, 80442, 76005, 75775, 75776, 74740, 75266, 73721, 73974, 71371, 68313, 65416];
  const f = btcDirectionForecast(closes);
  assert.equal(f.answer, 'no');
  assert.equal(f.confidence, 0.35);
});

test('btc: strong uptrend -> yes, capped at 0.65', () => {
  const closes = [60000, 61000, 62000, 63000, 64000, 66000, 68000, 70000, 72000, 74000, 76000, 78000, 80000, 82000, 85000];
  const f = btcDirectionForecast(closes);
  assert.equal(f.answer, 'yes');
  assert.equal(f.confidence, 0.65);
});

test('btc: flat market -> yes/no near 0.5, never outside [0.35, 0.65]', () => {
  const closes = [65000, 65100, 64900, 65050, 65000, 65100, 64950, 65000, 65020, 64980, 65010, 65000, 65030, 64990, 65000];
  const f = btcDirectionForecast(closes);
  assert.ok(f.confidence >= 0.35 && f.confidence <= 0.65);
});

test('btc: needs >= 8 closes', () => {
  assert.throws(() => btcDirectionForecast([1, 2, 3]), /needs >= 8/);
});

test('nvda: damped momentum, move clamped to 5%', () => {
  const f = nvdaCloseForecast([200, 202, 198, 205, 210, 208, 204, 200, 195, 190, 185, 180, 175, 170, 162.85]);
  // 3d return = 162.85/175 - 1 = -6.94%; damped 0.25x = -1.74% -> ~160.02
  assert.ok(f.forecast < 162.85 && f.forecast > 155, `forecast ${f.forecast}`);
});

test('nvda: crash input cannot move forecast more than 5%', () => {
  const f = nvdaCloseForecast([200, 200, 200, 200, 200, 200, 200, 200, 200, 100]);
  assert.ok(f.forecast >= 95 && f.forecast <= 105, `forecast ${f.forecast}`);
});
