<template>
  <div
    v-if="option"
    ref="boxRef"
    class="line-box"
    :style="boxStyle"
  >
    <v-chart
      ref="chartRef"
      class="chart"
      :option="option"
    />
  </div>
</template>

<script setup>
/**
 * 折线图
 */
import {
  ref,
  computed,
  onMounted,
  onUnmounted,
  onActivated,
  onDeactivated,
  nextTick,
} from 'vue';
import VChart from 'vue-echarts';
import lineChart from './line';

const props = defineProps({
  dateList: {
    type: Array,
    default: () => [],
  },
  valueList: {
    type: Array,
    default: () => [],
  },
  size: {
    type: [Number, String],
    default: null,
  },
  connectNulls: {
    type: [Boolean, String],
    default: true,
  },
  chartConfig: {
    type: Object,
    default: () => ({}),
  },
  mode: {
    type: String,
    default: 'dark',
  },
});

const chartRef = ref();
const boxRef = ref();
let resizeObserver = null;
let resizeFrame = null;
let active = true;
const option = computed(() => {
  if (props.dateList && props.valueList) {
    return lineChart({
      dateList: props.dateList,
      valueList: props.valueList,
      connectNulls: props.connectNulls,
      chartConfig: props.chartConfig,
      mode: props.mode,
    });
  }
  return null;
});
const boxStyle = computed(() => {
  const style = {};
  if (props.size > 0) {
    style.height = `${props.size}px`;
  }
  return style;
});

function handleResize() {
  if (!active || resizeFrame !== null) return;
  resizeFrame = window.requestAnimationFrame(() => {
    resizeFrame = null;
    if (boxRef.value?.clientWidth && boxRef.value?.clientHeight) chartRef.value?.resize?.();
  });
}

function observeSize() {
  if (typeof ResizeObserver !== 'undefined' && boxRef.value && !resizeObserver) {
    resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(boxRef.value);
  }
}

function stopResize() {
  active = false;
  resizeObserver?.disconnect();
  resizeObserver = null;
  if (resizeFrame !== null) window.cancelAnimationFrame(resizeFrame);
  resizeFrame = null;
}

onMounted(() => {
  observeSize();
  handleResize();
  window.addEventListener('resize', handleResize);
});
onActivated(() => {
  active = true;
  nextTick(() => {
    if (!active) return;
    observeSize();
    handleResize();
  });
});
onDeactivated(stopResize);
onUnmounted(() => {
  stopResize();
  window.removeEventListener('resize', handleResize);
});

</script>

<style lang="scss" scoped>
.line-box {
  width: 100%;
  height: var(--line-chart-size, 300px);
}
</style>
