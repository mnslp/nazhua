/* eslint-env node */
import assert from 'node:assert/strict';
import { test } from 'node:test';
// eslint-disable-next-line import/extensions
import { buildMonitorSeries, getThreshold } from '../src/views/composable/server-monitor.js';

const baseTime = Date.UTC(2026, 10, 6);
const minute = 60000;
const monitor = (offsets, delays = offsets.map(() => 20)) => ({
  created_at: offsets.map((offset) => baseTime + offset * minute),
  avg_delay: delays,
});

test('keeps non-aligned timestamps and tolerates sampling jitter', () => {
  const input = monitor([0.1, 1.12, 2.08, 3.15]);
  const result = buildMonitorSeries(input, { startTime: baseTime, endTime: baseTime + 4 * minute });
  assert.deepEqual(result.data, input.created_at.map((time) => [time, 20]));
  assert.equal(result.over, 100);
});

test('downsampled history stays continuous at five-minute and hourly intervals', () => {
  [5, 60].forEach((step) => {
    const input = monitor([0, step, step * 2, step * 3]);
    const result = buildMonitorSeries(input);
    assert.deepEqual(result.data, input.created_at.map((time) => [time, 20]));
    assert.equal(result.over, 100);
  });
});

test('keeps the latest point, including a single point at the range end', () => {
  const result = buildMonitorSeries(monitor([0]), { endTime: baseTime });
  assert.deepEqual(result.data, [[baseTime, 20]]);
});

test('missing samples produce a gap at the observed sampling interval', () => {
  [1, 5].forEach((step) => {
    const result = buildMonitorSeries(monitor([0, step, step * 3, step * 4]));
    assert.deepEqual(result.data, [
      [baseTime, 20],
      [baseTime + step * minute, 20],
      [baseTime + step * 2 * minute, null],
      [baseTime + step * 3 * minute, 20],
      [baseTime + step * 4 * minute, 20],
    ]);
    assert.equal(result.over, 80);
  });
});

test('timeouts and invalid delays remain gaps instead of being connected', () => {
  const result = buildMonitorSeries(monitor([0, 1, 2, 3, 4, 5, 6], [20, 0, null, undefined, NaN, Infinity, 20]));
  assert.deepEqual(result.data.map(([, value]) => value), [20, null, null, null, null, null, 20]);
  assert.equal(result.over, 28.57);
});

test('peak shaving does not create gaps or change the success rate', () => {
  const input = monitor([0, 1, 2, 3, 4], [20, 20, 200, 0, 20]);
  const raw = buildMonitorSeries(input);
  const shaved = buildMonitorSeries(input, { peakShaving: true });
  assert.deepEqual(shaved.data, [
    [baseTime, 20], [baseTime + minute, 20],
    [baseTime + 3 * minute, null], [baseTime + 4 * minute, 20],
  ]);
  assert.equal(shaved.over, raw.over);
  assert.equal(shaved.validRate, 25);
  assert.equal(shaved.avg, 20);
});

test('sorts and deduplicates timestamps before applying the visible range', () => {
  const input = monitor([3, 1, 2, 1, 0], [30, 10, 20, 15, 5]);
  const result = buildMonitorSeries(input, { startTime: baseTime + minute, endTime: baseTime + 2 * minute });
  assert.deepEqual(result.data, [[baseTime + minute, 15], [baseTime + 2 * minute, 20]]);
});

test('uses the supplied server time for a stale tail and bounds long history by its data', () => {
  const input = monitor([0, 1, 2]);
  const result = buildMonitorSeries(input, { endTime: baseTime + 5 * minute });
  assert.deepEqual(result.data.slice(-2), [[baseTime + 3 * minute, null], [baseTime + 5 * minute, null]]);
  assert.equal(result.over, 50);
  assert.equal(buildMonitorSeries(input).data.length, 3);
});

test('handles empty history and ignores invalid values in the shaving threshold', () => {
  assert.deepEqual(buildMonitorSeries({}), { data: [], avg: 0, over: 0, validRate: 0 });
  assert.equal(getThreshold([undefined, NaN, Infinity, null, 0, 10, 20, 30]).median, 20);
  assert.equal(getThreshold([1.9, 1.1, 1.2]).median, 1.2);
});
