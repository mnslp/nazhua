import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { setImmediate as flush } from 'node:timers/promises';
import { test } from 'node:test';
import { parse, compileScript } from '@vue/compiler-sfc';
import { ref, shallowRef, computed, watch, effectScope, nextTick, reactive } from 'vue';
import { getPollingDelay, getReconnectDelay } from '../src/utils/polling.js';
import axios from 'axios';

function source(path) {
  return readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');
}

function loadSubscriber() {
  const context = {};
  runInNewContext(source('utils/subscribe.js')
    .replaceAll('import.meta.env.VITE_LIVE_SUBSCRIBE_DEBUG', 'false')
    .replace('export default MessageSubscribe;', 'globalThis.MessageSubscribe = MessageSubscribe;'), context);
  return new context.MessageSubscribe();
}

function setupComponent(path, dependencies = {}, props = {}) {
  const { descriptor } = parse(source(path));
  const compiled = compileScript(descriptor, { id: path }).content;
  const hooks = { mounted: [], unmounted: [], activated: [], deactivated: [] };
  const timers = new Map();
  let timerId = 0;
  const context = {
    ref, shallowRef, computed, watch, nextTick, console, AbortController, URLSearchParams,
    getPollingDelay, getReconnectDelay: (attempt) => getReconnectDelay(attempt, () => 0),
    loadSarasaFont: () => Promise.resolve(),
    provide: () => {},
    onMounted: (fn) => hooks.mounted.push(fn),
    onUnmounted: (fn) => hooks.unmounted.push(fn),
    onActivated: (fn) => hooks.activated.push(fn),
    onDeactivated: (fn) => hooks.deactivated.push(fn),
    setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
    LineChart: {}, VChart: {}, DotDotBox: {}, LayoutMain: {},
    ...dependencies,
  };
  context.window = {
    localStorage: { getItem: () => null, setItem: () => {} },
    setTimeout: context.setTimeout,
    clearTimeout: context.clearTimeout,
    requestAnimationFrame: (fn) => context.setTimeout(fn, 16),
    cancelAnimationFrame: context.clearTimeout,
    addEventListener: () => {}, removeEventListener: () => {},
  };
  runInNewContext(compiled.replace(/^import[\s\S]*?;\n/gm, '')
    .replace('export default', 'globalThis.component ='), context);
  const scope = effectScope();
  const state = scope.run(() => context.component.setup(reactive(props), { expose: () => {} }));
  hooks.unmounted.push(() => scope.stop());
  const invoke = async (name) => Promise.all(hooks[name].map((fn) => fn()));
  return { state, hooks, timers, invoke, context };
}

test('one-time subscriptions do not skip adjacent listeners or run again on recursive emit', () => {
  const bus = loadSubscriber();
  const calls = [];
  bus.once('event', () => calls.push('first'));
  bus.once('event', () => calls.push('second'));
  bus.on('event', () => calls.push('persistent'));
  bus.emit('event');
  assert.deepEqual(calls, ['first', 'second', 'persistent']);
  let onceCount = 0;
  bus.once('nested', () => { onceCount += 1; bus.emit('nested'); });
  bus.emit('nested');
  assert.equal(onceCount, 1);
});

function requestHarness() {
  const calls = [];
  const transport = (options) => new Promise((resolve, reject) => {
    calls.push({ options, resolve, reject });
    options.signal?.addEventListener('abort', () => reject(new axios.CanceledError()));
  });
  transport.isCancel = axios.isCancel;
  transport.CanceledError = axios.CanceledError;
  const context = { axios: transport, uuid: randomUUID, CustomError: Error, setTimeout: () => {} };
  const code = source('utils/request.js')
    .replace(/^import[^;]+;\s*/gm, '')
    .replace(/export \{\s*NetworkRequest,\s*\};/, 'globalThis.NetworkRequest = NetworkRequest;')
    .replace('export default (...args) => request.push(...args);', '');
  runInNewContext(code, context);
  return { queue: new context.NetworkRequest(), calls };
}

test('canceled queued requests settle without corrupting the concurrency counter', { timeout: 2000 }, async () => {
  const { queue, calls } = requestHarness();
  const active = Array.from({ length: 10 }, (_, index) => queue.push({ url: `/active/${index}` }));
  const controller = new AbortController();
  const canceled = queue.push({ url: '/canceled' }, { abortController: controller });
  const rejection = assert.rejects(canceled, (error) => axios.isCancel(error));
  const next = queue.push({ url: '/next' });
  controller.abort();
  calls[0].resolve({ status: 200 });
  await rejection;
  assert.equal(queue.tasking, 10);
  assert.equal(calls.at(-1).options.url, '/next');
  assert.equal(calls.some((call) => call.options.url === '/canceled'), false);
  calls.slice(1).forEach((call) => call.resolve({ status: 200 }));
  await Promise.all([...active, next]);
  assert.equal(queue.tasking, 0);
});

test('queued priority requests run first and ordinary requests retain FIFO order', async () => {
  const { queue, calls } = requestHarness();
  const tasks = Array.from({ length: 10 }, (_, index) => queue.push({ url: `/${index}` }));
  tasks.push(queue.push({ url: '/first' }), queue.push({ url: '/second' }));
  tasks.push(queue.push({ url: '/priority' }, {}, true));
  calls[0].resolve({});
  await flush();
  assert.equal(calls.at(-1).options.url, '/priority');
  calls.at(-1).resolve({});
  await flush();
  assert.equal(calls.at(-1).options.url, '/first');
  calls.at(-1).resolve({});
  await flush();
  assert.equal(calls.at(-1).options.url, '/second');
  calls.forEach((call) => call.resolve({}));
  await Promise.all(tasks);
});

test('active cancellation rejects once and frees its request slot', async () => {
  const { queue } = requestHarness();
  const controller = new AbortController();
  const task = queue.push({ url: '/active' }, { abortController: controller });
  const rejection = assert.rejects(task, (error) => axios.isCancel(error));
  controller.abort();
  await rejection;
  await flush();
  assert.equal(queue.tasking, 0);
});

test('socket errors still reconnect and reconnects do not duplicate store subscriptions', async () => {
  const msg = loadSubscriber();
  const dispatches = [];
  let activations = 0;
  let closes = 0;
  const harness = setupComponent('App.vue', {
    msg,
    config: { init: true, nazhua: {} }, initConfig: async () => {},
    useStore: () => ({ dispatch: async (name) => dispatches.push(name) }),
    useRoute: () => ({}),
    navigator: { userAgent: 'test' },
    document: { body: { classList: { add: () => {}, remove: () => {} } } },
    WS_CONNECTION_STATUS: { CLOSED: -1 },
    wsService: { close: () => { closes += 1; } }, restart: () => {},
    activeWebsocketService: () => { activations += 1; },
  });
  await harness.invoke('mounted');
  assert.equal(harness.timers.size, 1); // One animation loop, not two.
  msg.emit('error');
  msg.emit('close');
  const retry = [...harness.timers.entries()].filter(([id]) => id !== 1);
  assert.equal(retry.length, 1);
  harness.timers.delete(retry[0][0]);
  retry[0][1].fn();
  assert.equal(activations, 2);
  msg.emit('connect');
  msg.emit('connect');
  assert.equal(dispatches.filter((name) => name === 'watchWsMsg').length, 1);
  await harness.invoke('unmounted');
  msg.emit('close');
  assert.equal(harness.timers.size, 0);
  assert.equal(closes, 1);
});

test('WebSocket URL follows the backend version detected after module initialization', () => {
  const config = { nazhua: { wsPath: '/ws', v1WsPath: '/api/v1/ws/server', nezhaVersion: null } };
  const context = {
    config,
    MessageSubscribe: class { once() {} emit() {} },
    WSService: class {
      constructor(options) { this.$wsUrl = options.wsUrl; this.connected = 0; }
      active() { this.connected = 1; }
    },
    WS_CONNECTION_STATUS: { CONNECTED: 2, CONNECTING: 1 },
    v1TransformV0: (data) => data,
    document: { createElement: () => ({
      set href(value) { this.url = new URL(value, 'https://monitor.example').href; },
      get href() { return this.url; },
    }) },
  };
  const code = source('ws/index.js').replace(/^import[^;]+;\s*/gm, '')
    .replace(/export \{[\s\S]*?\};/, 'globalThis.service = wsService;')
    .replace('export default', 'globalThis.activate =');
  runInNewContext(code, context);
  config.nazhua.nezhaVersion = 'v1';
  context.activate();
  assert.equal(context.service.$wsUrl, 'wss://monitor.example/api/v1/ws/server');
});

test('resource history passes cancellation and cannot restart polling after leaving the page', async () => {
  const requests = [];
  const harness = setupComponent('views/components/server-detail/server-resource-history.vue', {
    useStore: () => ({ state: { serverTime: Date.now() } }),
    config: { nazhua: { nezhaVersion: 'v1', v1ApiMetricsPath: '/metrics/{id}' } },
    isTsdbEnabled: () => true, hasTsdb: () => true,
    request: (options, controller) => new Promise((resolve) => requests.push({ options, controller, resolve })),
  }, { info: { ID: 1 } });
  assert.equal(requests.length, 9);
  const { signal } = requests[0].controller.abortController;
  assert.equal(signal.aborted, false);
  await harness.invoke('deactivated');
  assert.equal(signal.aborted, true);
  requests.forEach(({ resolve }) => resolve({ status: 200, data: { success: true, data: { data_points: [] } } }));
  await flush();
  assert.equal(harness.timers.size, 0);
  const netCard = harness.state.historyCards.value.find((card) => card.key === 'net_speed');
  assert.equal(netCard.valueList.find((series) => series.id === 'net_in_speed').name, '下载');
  assert.equal(netCard.valueList.find((series) => series.id === 'net_out_speed').name, '上传');
  await harness.invoke('activated');
  assert.equal(requests.length, 18);
  await harness.invoke('unmounted');
  requests.slice(9).forEach(({ resolve }) => resolve(null));
  await flush();
  assert.equal(harness.timers.size, 0);
});

test('cycle transfer discards late results and stops polling on deactivation', async () => {
  const requests = [];
  const harness = setupComponent('views/components/server-detail/server-cycle-transfer.vue', {
    config: { nazhua: {} },
    getCycleTransferStatusLabel: () => '',
    loadCycleTransferByServer: () => new Promise((resolve) => requests.push(resolve)),
  }, { info: { ID: 1 } });
  const mount = harness.invoke('mounted');
  await harness.invoke('deactivated');
  requests[0]([{ ruleId: 1 }]);
  await mount;
  assert.equal(harness.state.cycleTransferList.value.length, 0);
  assert.equal(harness.timers.size, 0);
  const activate = harness.invoke('activated');
  assert.equal(requests.length, 2);
  requests[1]([]);
  await activate;
  assert.equal(harness.timers.size, 1);
  await harness.invoke('unmounted');
  assert.equal(harness.timers.size, 0);
});

function resourceHarness() {
  const requests = [];
  const now = Date.now();
  const harness = setupComponent('views/components/server-detail/server-resource-history.vue', {
    useStore: () => ({ state: { serverTime: now, profile: { username: 'tester' } } }),
    config: { nazhua: { nezhaVersion: 'v1', v1ApiMetricsPath: '/metrics/{id}' } },
    isTsdbEnabled: () => true, hasTsdb: () => true,
    request: (options, controller) => new Promise((resolve) => requests.push({ options, controller, resolve })),
  }, { info: { ID: 1 } });
  const reply = (batch, points) => batch.forEach(({ resolve }) => resolve({
    status: 200, data: { success: true, data: { data_points: points } },
  }));
  return { ...harness, requests, now, reply };
}

test('daily windows reuse nine requests, preserve older samples and keep empty controls visible', async () => {
  const { state, requests, now, reply, invoke } = resourceHarness();
  assert.equal(requests.length, 9);
  reply(requests, [{ ts: now - 18 * 3600000, value: 10 }, { ts: now - 3600000, value: 20 }]);
  await flush();
  assert.equal(state.metricHistory.value.cpu.length, 2);
  state.period.value = 720;
  await nextTick();
  assert.equal(requests.length, 9);
  assert.equal(state.metricHistory.value.cpu.length, 1);
  state.period.value = 30;
  await nextTick();
  assert.equal(state.metricHistory.value.cpu.length, 0);
  assert.equal(state.isModuleVisible.value, true);
  assert.equal(state.loadError.value, '');
  state.period.value = 1440;
  await nextTick();
  assert.equal(state.metricHistory.value.cpu.length, 2);
  assert.equal(requests.length, 9);
  await invoke('unmounted');
});

test('refresh failures retain cached values and explicit retry clears the error', async () => {
  const { state, requests, now, reply, invoke } = resourceHarness();
  reply(requests, [{ ts: now, value: 20 }]);
  await flush();
  const refresh = state.loadMetrics(false, true);
  requests.slice(9).forEach(({ resolve }) => resolve(null));
  await refresh;
  assert.match(state.loadError.value, /加载失败/);
  assert.equal(state.metricHistory.value.cpu[0].value, 20);
  assert.equal(state.isModuleVisible.value, true);
  const retry = state.loadMetrics(true, true);
  reply(requests.slice(18), []);
  await retry;
  assert.equal(state.loadError.value, '');
  assert.equal(state.metricHistory.value.cpu.length, 0);
  assert.equal(state.isModuleVisible.value, true);
  await invoke('unmounted');
});

test('switching API periods uses distinct caches and retries an initial failure', async () => {
  const { state, requests, now, reply, invoke } = resourceHarness();
  requests.forEach(({ resolve }) => resolve(null));
  await flush();
  assert.match(state.loadError.value, /加载失败/);
  assert.equal(state.isModuleVisible.value, true);
  const retry = state.loadMetrics(true, true);
  reply(requests.slice(9), [{ ts: now, value: 20 }]);
  await retry;
  state.period.value = 10080;
  await nextTick();
  assert.equal(requests.length, 27);
  assert.match(requests.at(-1).options.url, /period=7d/);
  reply(requests.slice(18), [{ ts: now, value: 70 }]);
  await flush();
  state.period.value = 1440;
  await nextTick();
  assert.equal(requests.length, 27);
  assert.equal(state.metricHistory.value.cpu[0].value, 20);
  await invoke('unmounted');
});

test('polling slows in the background and reconnect backoff is capped', () => {
  assert.equal(getPollingDelay(10000, false), 10000);
  assert.equal(getPollingDelay(10000, true), 60000);
  assert.equal(getPollingDelay(120000, true), 120000);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map((attempt) => getReconnectDelay(attempt, () => 0)),
    [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
});

test('request timeout has a finite default and supports a per-request override', async () => {
  const { queue, calls } = requestHarness();
  const tasks = [queue.push({ url: '/default' }), queue.push({ url: '/custom', timeout: 2500 })];
  assert.equal(calls[0].options.timeout, 15000);
  assert.equal(calls[1].options.timeout, 2500);
  calls.forEach(({ resolve }) => resolve({}));
  await Promise.all(tasks);
});

test('chart resize follows container changes, batches events and resumes after activation', async () => {
  const observers = [];
  let resized = 0;
  const harness = setupComponent('components/charts/line.vue', {
    lineChart: () => ({}),
    ResizeObserver: class {
      constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this); }
      observe() {}
      disconnect() { this.disconnected = true; }
    },
  }, { dateList: [], valueList: [], size: 240 });
  harness.state.boxRef.value = { clientWidth: 400, clientHeight: 240 };
  harness.state.chartRef.value = { resize: () => { resized += 1; } };
  await harness.invoke('mounted');
  observers[0].callback();
  observers[0].callback();
  assert.equal(harness.timers.size, 1);
  const [id, timer] = [...harness.timers][0];
  harness.timers.delete(id);
  timer.fn();
  assert.equal(resized, 1);
  await harness.invoke('deactivated');
  assert.equal(observers[0].disconnected, true);
  observers[0].callback();
  assert.equal(harness.timers.size, 0);
  await harness.invoke('activated');
  await nextTick();
  assert.equal(observers.length, 2);
  assert.equal(harness.timers.size, 1);
  await harness.invoke('unmounted');
  assert.equal(harness.timers.size, 0);
});

test('time-axis intervals reach the chart and short history uses five-minute ticks', async () => {
  const context = {
    use: () => {}, SVGRenderer: {}, LineChart: {}, TooltipComponent: {}, GridComponent: {}, DataZoomComponent: {},
    config: { nazhua: { disableSarasaTermSC: true } },
  };
  runInNewContext(source('components/charts/line.js').replace(/^import[\s\S]*?;\n/gm, '')
    .replace('export default', 'globalThis.makeChart ='), context);
  const option = context.makeChart({ valueList: [], chartConfig: { xAxis: { minInterval: 300000 } } });
  assert.equal(option.xAxis.minInterval, 300000);
  const harness = resourceHarness();
  harness.state.period.value = 30;
  assert.equal(harness.state.getXAxisConfig().minInterval, 300000);
  await harness.invoke('unmounted');
  harness.reply(harness.requests, []);
  await flush();
});
