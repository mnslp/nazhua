import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { parse, compileScript } from '@vue/compiler-sfc';
import { ref, computed, reactive } from 'vue';
import { getPollingDelay } from '../src/utils/polling.js';
import { buildMonitorSeries, prepareMonitorData } from '../src/views/composable/server-monitor.js';

// Compile the real setup function; replace only its external services and lifecycle hooks.
const filename = new URL('../src/views/components/server-detail/server-monitor.vue', import.meta.url);
const { descriptor } = parse(readFileSync(filename, 'utf8'));
const compiled = compileScript(descriptor, { id: 'monitor-test' }).content;
const setupSource = compiled.replace(/^import[\s\S]*?;\n/gm, '').replace('export default', 'globalThis.component =');
const baseTime = Date.UTC(2026, 10, 6);
const sample = (id) => ({
  monitor_id: id,
  monitor_name: `Monitor ${id}`,
  created_at: [baseTime, baseTime + 60000],
  avg_delay: [20, 21],
});
const response = (data) => ({ data: { data } });

function createHarness(refreshSeconds = 30) {
  const pending = [];
  const timers = [];
  const unmountHooks = [];
  const activateHooks = [];
  const deactivateHooks = [];
  const store = { state: reactive({ serverTime: baseTime + 60000 }) };
  const context = {
    ref,
    computed,
    onMounted: () => {},
    onUnmounted: (callback) => unmountHooks.push(callback),
    onActivated: (callback) => activateHooks.push(callback),
    onDeactivated: (callback) => deactivateHooks.push(callback),
    useStore: () => store,
    config: {
      nazhua: {
        nezhaVersion: 'v1',
        monitorChartType: 'multi',
        monitorChartTypeToggle: true,
        monitorRefreshTime: refreshSeconds,
        v1ApiMonitorPath: '/api/v1/server/{id}/service',
      },
    },
    request: ({ url }) => new Promise((resolve) => pending.push({ url, resolve })),
    validate: { isSet: (value) => value !== null && value !== undefined },
    isTsdbEnabled: () => true,
    hasTsdb: () => true,
    LineChart: {},
    buildMonitorSeries,
    prepareMonitorData,
    getPollingDelay,
    getLineColor: () => '#5470c6',
    window: { innerWidth: 1200, localStorage: { getItem: () => null, setItem: () => {} } },
    setTimeout: (callback, delay) => { timers.push({ callback, delay }); return timers.length; },
    clearTimeout: () => {},
    console,
  };
  runInNewContext(setupSource, context);
  const state = context.component.setup({ info: { ID: 1 } }, { expose: () => {} });
  return {
    state, pending, timers, store,
    unmount: () => unmountHooks.forEach((callback) => callback()),
    activate: () => activateHooks.forEach((callback) => callback()),
    deactivate: () => deactivateHooks.forEach((callback) => callback()),
  };
}

test('24h to 12h keeps recent data when sampling is not aligned to whole minutes', async () => {
  const { state, pending } = createHarness();
  const now = baseTime + 60000;
  const input = {
    ...sample(1),
    // The oldest point is inside 24h, but outside 12h, with a 15-second offset.
    created_at: Array.from({ length: 1080 }, (_, index) => now - 18 * 3600000 + 15000 + index * 60000),
    avg_delay: Array.from({ length: 1080 }, () => 20),
  };
  state.monitorData.value = [input];
  for (const chartType of ['multi', 'single']) {
    state.chartType.value = chartType;
    await state.toggleMinute(1440);
    assert.equal(state.monitorChartData.value.valueList[0].data.length, 1080);
    await state.toggleMinute(720);
    const data = state.monitorChartData.value.valueList[0].data;
    assert.equal(data.length, 720);
    assert.ok(data.every(([time, value]) => time >= now - 12 * 3600000 && value === 20));
    assert.equal(data.at(-1)[0], input.created_at.at(-1));
  }
  // Both ranges use the same daily response; switching only filters the visible points.
  assert.equal(pending.length, 0);
});

test('second-level heartbeats and legend changes reuse prepared history and series', () => {
  const { state, store } = createHarness();
  state.monitorData.value = [sample(1)];
  const prepared = state.preparedMonitors.value;
  const series = state.monitorSeries.value;
  store.state.serverTime += 1000;
  assert.equal(state.monitorSeries.value, series);
  state.toggleShowCate(1);
  assert.equal(state.preparedMonitors.value, prepared);
  assert.equal(state.monitorSeries.value, series);
  store.state.serverTime += 60000;
  assert.equal(state.preparedMonitors.value, prepared);
  assert.notEqual(state.monitorSeries.value, series);
});

test('switching back from long history reloads the daily API period even with refresh disabled', async () => {
  const { state, pending } = createHarness();
  state.refreshData.value = false;
  const longLoad = state.toggleMinute(10080);
  assert.match(pending[0].url, /period=7d$/);
  pending[0].resolve(response([sample(1)]));
  await longLoad;
  const shortLoad = state.toggleMinute(30);
  assert.match(pending[1].url, /period=1d$/);
  pending[1].resolve(response([sample(2)]));
  await shortLoad;
  await state.toggleMinute(60);
  assert.equal(pending.length, 2);
  assert.equal(state.monitorData.value[0].monitor_id, 2);
});

test('a stale response cannot overwrite the selected period', async () => {
  const { state, pending } = createHarness();
  const oldLoad = state.toggleMinute(10080);
  const newLoad = state.toggleMinute(30);
  pending[1].resolve(response([sample(2)]));
  await newLoad;
  pending[0].resolve(response([sample(1)]));
  await oldLoad;
  assert.equal(state.monitorData.value[0].monitor_id, 2);
});

test('hidden aggregate series do not shift the data in individual charts', () => {
  const { state } = createHarness();
  state.monitorData.value = [sample(1), sample(2)];
  state.toggleShowCate(1);
  assert.equal(state.monitorChartData.value.valueList.length, 1);
  assert.equal(state.monitorChartData.value.valueList[0].id, 2);
  state.switchChartType();
  const chart = state.monitorChartData.value;
  assert.equal(chart.valueList.length, 2);
  chart.cateList.forEach((category) => {
    assert.equal(chart.valueList.find((series) => series.id === category.id).name, category.name);
  });
});

test('refresh respects the configured interval and the ten-second minimum', async () => {
  for (const [seconds, expectedDelay] of [[30, 30000], [5, 10000], [0, null]]) {
    const { state, timers } = createHarness(seconds);
    state.refreshData.value = false;
    await state.setTimeLoadMonitor();
    assert.equal(timers[0]?.delay ?? null, expectedDelay);
  }
});

test('unmounting during a request prevents data updates and rescheduling', async () => {
  const { state, pending, timers, unmount } = createHarness();
  const load = state.setTimeLoadMonitor(true);
  unmount();
  pending[0].resolve(response([sample(1)]));
  await load;
  assert.equal(state.monitorData.value.length, 0);
  assert.equal(timers.length, 0);
});

test('leaving a cached detail page stops polling and returning reloads it', async () => {
  const { state, pending, timers, deactivate, activate } = createHarness();
  const load = state.setTimeLoadMonitor(true);
  deactivate();
  pending[0].resolve(response([sample(1)]));
  await load;
  assert.equal(state.monitorData.value.length, 0);
  assert.equal(timers.length, 0);
  await state.setTimeLoadMonitor();
  assert.equal(pending.length, 1);
  activate();
  assert.equal(pending.length, 2);
  deactivate();
  pending[1].resolve(response([]));
});
