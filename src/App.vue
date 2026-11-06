<template>
  <layout-main>
    <router-view v-slot="{ Component }">
      <keep-alive>
        <component :is="Component" />
      </keep-alive>
    </router-view>
  </layout-main>
</template>

<script setup>
import {
  ref,
  computed,
  watch,
  provide,
  onMounted,
  onUnmounted,
} from 'vue';
import { useStore } from 'vuex';
import { useRoute } from 'vue-router';
import config, {
  init as initConfig,
} from '@/config';
import LayoutMain from './layout/main.vue';
import { loadSarasaFont } from './load';
import { getReconnectDelay } from '@/utils/polling';

import { WS_CONNECTION_STATUS } from './ws/service';
import activeWebsocketService, {
  wsService,
  restart,
  msg,
} from './ws';

const store = useStore();
const route = useRoute();

const currentTime = ref(Date.now());

provide('currentTime', currentTime);

// 只需要秒级时钟，无需每帧执行；后台标签页降低唤醒频率。
let clockTimer = null;
function refreshTime() {
  currentTime.value = Date.now();
  clockTimer = window.setTimeout(refreshTime, document.hidden ? 60000 : 1000);
}

// 是否为Windows系统
const isWindows = /windows|win32/i.test(navigator.userAgent);
if (isWindows) {
  document.body.classList.add('windows');
}
// 是否加载Sarasa Term SC字体
const loadSarasaTermSC = computed(() => config.nazhua.disableSarasaTermSC !== true);
watch(loadSarasaTermSC, (value) => {
  if (value) {
    loadSarasaFont().catch((error) => console.warn('字体加载失败，使用系统字体', error));
    document.body.classList.add('sarasa-term-sc');
  } else {
    document.body.classList.remove('sarasa-term-sc');
  }
}, {
  immediate: true,
});

/**
 * websocket断连的自动重连
 */
let reconnectTimer = null;
let reconnectAttempt = 0;
let disposed = false;
function clearReconnectTimer() {
  if (reconnectTimer !== null) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}
function wsReconnect() {
  if (disposed || reconnectTimer !== null) return;
  const delay = getReconnectDelay(reconnectAttempt);
  reconnectAttempt += 1;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    if (!disposed) activeWebsocketService();
  }, delay);
}
function handleConnect() {
  reconnectAttempt = 0;
  clearReconnectTimer();
}
function handleFocus() {
  if (wsService.connected === WS_CONNECTION_STATUS.CLOSED) {
    clearReconnectTimer();
    restart();
  }
}
function handleUnhandledRejection(event) {
  console.error('未处理的rejection:', event.reason);
  event.preventDefault();
}

onMounted(async () => {
  refreshTime();

  // 如果没有配置哪吒版本，尝试载入 v1 版本配置
  if (!config.init) {
    await initConfig();
  }
  if (disposed) return;

  /**
   * 初始化服务器信息
   */
  await store.dispatch('initServerInfo', {
    route,
  });

  if (disposed) return;

  // 数据监听仅注册一次，重连时复用，避免每条消息重复更新 store。
  store.dispatch('watchWsMsg');
  msg.on('close', wsReconnect);
  msg.on('error', wsReconnect);
  msg.on('connect', handleConnect);
  window.addEventListener('focus', handleFocus);
  window.addEventListener('unhandledrejection', handleUnhandledRejection);
  activeWebsocketService();
});

onUnmounted(() => {
  disposed = true;
  clearReconnectTimer();
  window.clearTimeout(clockTimer);
  msg.off('close', wsReconnect);
  msg.off('error', wsReconnect);
  msg.off('connect', handleConnect);
  window.removeEventListener('focus', handleFocus);
  window.removeEventListener('unhandledrejection', handleUnhandledRejection);
  wsService.close();
});

</script>
