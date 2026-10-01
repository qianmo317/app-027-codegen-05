<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type { Pt } from '@/logic/types'
import { boundsOf, mergeBounds } from '@/logic/geometry'
import { stepPoints, type DiffEntry, type VersionDiff } from '@/logic/versions'

/**
 * 两版刀路叠加对照画布：
 * 共有段暗灰｜只在 A 版 红｜只在 B 版 蓝；连刀点 / 跳刀同样双色叠加。
 * 点差异清单条目后由父组件传入 activeEntry，画布自动框选定位。
 */
const props = withDefaults(
  defineProps<{
    diff: VersionDiff
    activeEntry?: DiffEntry | null
    showTravel?: boolean
    showBridges?: boolean
    sheetW?: number
    sheetH?: number
  }>(),
  {
    activeEntry: null,
    showTravel: true,
    showBridges: true,
    sheetW: 0,
    sheetH: 0,
  },
)

const wrap = ref<HTMLDivElement | null>(null)
const size = ref({ w: 800, h: 600 })
const zoom = ref(2)
const panX = ref(0)
const panY = ref(0)
let ro: ResizeObserver | null = null

function toPx(p: Pt): Pt {
  return { x: p.x * zoom.value + panX.value, y: p.y * zoom.value + panY.value }
}

function pointsToD(pts: Pt[], closed: boolean): string {
  if (pts.length === 0) return ''
  let d = `M${pts[0].x.toFixed(3)} ${pts[0].y.toFixed(3)}`
  for (let i = 1; i < pts.length; i++) d += `L${pts[i].x.toFixed(3)} ${pts[i].y.toFixed(3)}`
  if (closed) d += 'Z'
  return d
}

const allBounds = computed(() => {
  const list: ReturnType<typeof boundsOf>[] = []
  for (const v of [props.diff.a, props.diff.b]) {
    const pts = v.steps.flatMap(stepPoints)
    if (pts.length) list.push(boundsOf(pts))
  }
  if (props.sheetW > 0 && props.sheetH > 0) list.push({ minX: 0, minY: 0, maxX: props.sheetW, maxY: props.sheetH })
  if (list.length === 0) return { minX: 0, minY: 0, maxX: 100, maxY: 100 }
  return mergeBounds(list)
})

function fitBounds(b: { minX: number; minY: number; maxX: number; maxY: number }, pad = 26): void {
  const w = Math.max(40, size.value.w - pad * 2)
  const h = Math.max(40, size.value.h - pad * 2)
  const bw = Math.max(1, b.maxX - b.minX)
  const bh = Math.max(1, b.maxY - b.minY)
  zoom.value = Math.min(w / bw, h / bh)
  panX.value = pad + (w - bw * zoom.value) / 2 - b.minX * zoom.value
  panY.value = pad + (h - bh * zoom.value) / 2 - b.minY * zoom.value
}

function fit(): void {
  fitBounds(allBounds.value)
}

function zoomBy(f: number): void {
  const cx = size.value.w / 2
  const cy = size.value.h / 2
  const before = { x: (cx - panX.value) / zoom.value, y: (cy - panY.value) / zoom.value }
  zoom.value = Math.max(0.05, Math.min(200, zoom.value * f))
  panX.value = cx - before.x * zoom.value
  panY.value = cy - before.y * zoom.value
}

function localPoint(e: PointerEvent): Pt {
  const el = wrap.value
  if (!el) return { x: 0, y: 0 }
  const r = el.getBoundingClientRect()
  return { x: e.clientX - r.left, y: e.clientY - r.top }
}

function onWheel(e: WheelEvent): void {
  e.preventDefault()
  const el = wrap.value
  if (!el) return
  const r = el.getBoundingClientRect()
  const px = { x: e.clientX - r.left, y: e.clientY - r.top }
  const before = { x: (px.x - panX.value) / zoom.value, y: (px.y - panY.value) / zoom.value }
  zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12)
  const after = toPx(before)
  panX.value += px.x - after.x
  panY.value += px.y - after.y
}

// 平移
const dragging = ref(false)
const dragStart = ref({ x: 0, y: 0 })

function onDown(e: PointerEvent): void {
  if (e.button === 1 || e.button === 0) {
    dragging.value = true
    const px = localPoint(e)
    dragStart.value = { x: px.x - panX.value, y: px.y - panY.value }
    try {
      wrap.value?.setPointerCapture(e.pointerId)
    } catch {
      // 合成指针事件忽略
    }
  }
}
function onMove(e: PointerEvent): void {
  if (!dragging.value) return
  const px = localPoint(e)
  panX.value = px.x - dragStart.value.x
  panY.value = px.y - dragStart.value.y
}
function onUp(): void {
  dragging.value = false
}

onMounted(() => {
  const el = wrap.value
  if (!el) return
  ro = new ResizeObserver(() => {
    size.value = { w: el.clientWidth, h: el.clientHeight }
  })
  ro.observe(el)
  size.value = { w: el.clientWidth, h: el.clientHeight }
  fit()
})

onUnmounted(() => ro?.disconnect())

watch(
  () => [props.diff.a.id, props.diff.b.id, size.value.w, size.value.h],
  () => fit(),
)

watch(
  () => props.activeEntry?.id,
  () => {
    if (props.activeEntry) fitBounds(props.activeEntry.bounds, 40)
  },
)

defineExpose({ fit, zoomBy, fitBounds })

// ---------------- 渲染数据 ----------------

type PathItem = { d: string; color: string; width: number; key: string; opacity: number }

const COLOR_A = '#ff6b6b'
const COLOR_B = '#5aa9ff'
const COLOR_COMMON = '#4a5768'
const COLOR_A_DIM = 'rgba(255,107,107,0.55)'
const COLOR_B_DIM = 'rgba(90,169,255,0.55)'

const pathsA = computed<PathItem[]>(() =>
  props.diff.a.steps.map((s) => {
    const only = props.diff.marksA.get(s.seq) ?? false
    return {
      key: `a-${s.seq}`,
      d: pointsToD(stepPoints(s), s.closed),
      color: only ? COLOR_A : COLOR_COMMON,
      width: only ? 1.9 : 1.1,
      opacity: only ? 1 : 0.8,
    }
  }),
)

const pathsB = computed<PathItem[]>(() =>
  props.diff.b.steps.map((s) => {
    const only = props.diff.marksB.get(s.seq) ?? false
    return {
      key: `b-${s.seq}`,
      d: pointsToD(stepPoints(s), s.closed),
      color: only ? COLOR_B : COLOR_COMMON,
      width: only ? 1.9 : 1.1,
      opacity: only ? 1 : 0.55,
    }
  }),
)

type LineItem = { x1: number; y1: number; x2: number; y2: number; key: string; strong: boolean; color: string }

function travelLines(side: 'a' | 'b'): LineItem[] {
  if (!props.showTravel) return []
  const v = side === 'a' ? props.diff.a : props.diff.b
  const active = props.activeEntry
  const strongKeys = new Set<string>()
  if (active?.kind === 'travel') {
    for (const t of props.diff.travelRemoved) strongKeys.add(`a-${t.id}`)
    for (const t of props.diff.travelAdded) strongKeys.add(`b-${t.id}`)
    for (const r of props.diff.travelRerouted) {
      strongKeys.add(`a-${r.from.id}`)
      strongKeys.add(`b-${r.to.id}`)
    }
  }
  return v.travels.map((t) => {
    const key = `${side}-${t.id}`
    const changed =
      props.diff.travelRemoved.some((x) => x.id === t.id) ||
      props.diff.travelRerouted.some((x) => (side === 'a' ? x.from.id === t.id : x.to.id === t.id)) ||
      props.diff.travelAdded.some((x) => x.id === t.id)
    return {
      x1: t.from.x,
      y1: t.from.y,
      x2: t.to.x,
      y2: t.to.y,
      key,
      strong: strongKeys.has(key),
      color: !changed ? (side === 'a' ? COLOR_A_DIM : COLOR_B_DIM) : side === 'a' ? COLOR_A : COLOR_B,
    }
  })
}

const travelsA = computed(() => travelLines('a'))
const travelsB = computed(() => travelLines('b'))

type BridgeMark = { x: number; y: number; key: string; color: string; r: number }

function bridgeMarks(side: 'a' | 'b'): BridgeMark[] {
  if (!props.showBridges) return []
  const v = side === 'a' ? props.diff.a : props.diff.b
  const movedIds = new Set(props.diff.bridgeMoved.map((m) => (side === 'a' ? m.from.id : m.to.id)))
  const onlyIds = new Set((side === 'a' ? props.diff.bridgeRemoved : props.diff.bridgeAdded).map((x) => x.id))
  return v.bridges.map((br) => {
    const cx = (br.a.x + br.b.x) / 2
    const cy = (br.a.y + br.b.y) / 2
    const hot = movedIds.has(br.id) || onlyIds.has(br.id)
    return {
      x: cx,
      y: cy,
      key: `${side}-${br.id}`,
      color: hot ? (side === 'a' ? COLOR_A : COLOR_B) : side === 'a' ? COLOR_A_DIM : COLOR_B_DIM,
      r: hot ? 1.8 : 1.1,
    }
  })
}

const bridgesA = computed(() => bridgeMarks('a'))
const bridgesB = computed(() => bridgeMarks('b'))

const bridgeLines = computed(() => {
  if (!props.showBridges) return []
  const out: Array<{ x1: number; y1: number; x2: number; y2: number; key: string; color: string }> = []
  for (const br of props.diff.a.bridges) out.push({ x1: br.a.x, y1: br.a.y, x2: br.b.x, y2: br.b.y, key: `bl-a-${br.id}`, color: COLOR_A_DIM })
  for (const br of props.diff.b.bridges) out.push({ x1: br.a.x, y1: br.a.y, x2: br.b.x, y2: br.b.y, key: `bl-b-${br.id}`, color: COLOR_B_DIM })
  return out
})

const focusMarker = computed(() => {
  const e = props.activeEntry
  if (!e) return null
  const b = e.bounds
  return {
    rect: { ...b },
    p: toPx(e.focus),
    color: e.side === 'a' ? COLOR_A : COLOR_B,
    focus: e.focus,
  }
})

const gridLines = computed(() => {
  const b = allBounds.value
  let step = 10
  const span = Math.max(b.maxX - b.minX, b.maxY - b.minY)
  if (span / step > 40) step = 50
  if (span / step < 6) step = 5
  const v: number[] = []
  const h: number[] = []
  const x0 = Math.floor(b.minX / step) * step
  const y0 = Math.floor(b.minY / step) * step
  for (let x = x0; x <= b.maxX + step; x += step) v.push(x)
  for (let y = y0; y <= b.maxY + step; y += step) h.push(y)
  return { v, h, b, step }
})
</script>

<template>
  <div ref="wrap" class="diff-canvas" :class="{ grab: dragging }">
    <svg :width="size.w" :height="size.h" @pointerdown="onDown" @pointermove="onMove" @pointerup="onUp" @pointerleave="onUp" @wheel="onWheel">
      <g :transform="`translate(${panX} ${panY}) scale(${zoom})`">
        <!-- 网格 -->
        <g stroke="#212a35" stroke-width="1" vector-effect="non-scaling-stroke">
          <line v-for="x in gridLines.v" :key="`gv${x}`" :x1="x" :y1="gridLines.b.minY - 200" :x2="x" :y2="gridLines.b.maxY + 200" />
          <line v-for="y in gridLines.h" :key="`gh${y}`" :x1="gridLines.b.minX - 200" :y1="y" :x2="gridLines.b.maxX + 200" :y2="y" />
        </g>

        <!-- 纸幅（取两版中较大的纸幅设置） -->
        <rect
          v-if="sheetW > 0"
          :x="0"
          :y="0"
          :width="sheetW"
          :height="sheetH"
          fill="#151a20"
          stroke="#3a4654"
          stroke-width="1.5"
          vector-effect="non-scaling-stroke"
        />

        <!-- A 版刀路 -->
        <g fill="none" stroke-linecap="round" stroke-linejoin="round">
          <path
            v-for="p in pathsA"
            :key="p.key"
            :d="p.d"
            :stroke="p.color"
            :stroke-width="p.width"
            :opacity="p.opacity"
            vector-effect="non-scaling-stroke"
          />
        </g>
        <!-- B 版刀路 -->
        <g fill="none" stroke-linecap="round" stroke-linejoin="round">
          <path
            v-for="p in pathsB"
            :key="p.key"
            :d="p.d"
            :stroke="p.color"
            :stroke-width="p.width"
            :opacity="p.opacity"
            vector-effect="non-scaling-stroke"
          />
        </g>

        <!-- 跳刀 -->
        <g stroke-width="1" stroke-dasharray="4 4" fill="none" vector-effect="non-scaling-stroke">
          <line v-for="t in travelsA" :key="t.key" :x1="t.x1" :y1="t.y1" :x2="t.x2" :y2="t.y2" :stroke="t.color" :stroke-width="t.strong ? 1.8 : 1" />
          <line v-for="t in travelsB" :key="t.key" :x1="t.x1" :y1="t.y1" :x2="t.x2" :y2="t.y2" :stroke="t.color" :stroke-width="t.strong ? 1.8 : 1" />
        </g>

        <!-- 连刀点 -->
        <g>
          <line v-for="l in bridgeLines" :key="l.key" :x1="l.x1" :y1="l.y1" :x2="l.x2" :y2="l.y2" :stroke="l.color" :stroke-width="1.2 / zoom" />
          <circle v-for="m in bridgesA" :key="m.key" :cx="m.x" :cy="m.y" :r="m.r / zoom" :fill="m.color" />
          <circle v-for="m in bridgesB" :key="m.key" :cx="m.x" :cy="m.y" :r="m.r / zoom" :fill="m.color" stroke="#0d1116" :stroke-width="0.5 / zoom" />
        </g>

        <!-- 定位框 -->
        <g v-if="focusMarker">
          <rect
            :x="focusMarker.rect.minX"
            :y="focusMarker.rect.minY"
            :width="Math.max(0.001, focusMarker.rect.maxX - focusMarker.rect.minX)"
            :height="Math.max(0.001, focusMarker.rect.maxY - focusMarker.rect.minY)"
            fill="none"
            :stroke="focusMarker.color"
            :stroke-width="1.4 / zoom"
            stroke-dasharray="2 2"
          />
          <circle :cx="focusMarker.focus.x" :cy="focusMarker.focus.y" :r="2.2 / zoom" :fill="focusMarker.color" stroke="#fff" :stroke-width="0.8 / zoom" />
        </g>
      </g>
    </svg>

    <div class="canvas-tools no-print">
      <button class="tiny" title="缩小" @click="zoomBy(1 / 1.2)">−</button>
      <button class="tiny" title="放大" @click="zoomBy(1.2)">＋</button>
      <button class="tiny" title="适应窗口" @click="fit">适应</button>
      <span class="zoom-label mono">{{ (zoom * 100).toFixed(0) }}%</span>
    </div>

    <div class="legend-panel no-print">
      <span><i :style="{ background: COLOR_COMMON }"></i>两版共有</span>
      <span><i :style="{ background: COLOR_A }"></i>仅 A 版</span>
      <span><i :style="{ background: COLOR_B }"></i>仅 B 版</span>
    </div>
  </div>
</template>

<style scoped>
.diff-canvas {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  background: var(--bg-grid);
  overflow: hidden;
  touch-action: none;
  cursor: default;
}

.diff-canvas.grab {
  cursor: grabbing;
}

.diff-canvas svg {
  display: block;
}

.canvas-tools {
  position: absolute;
  right: 8px;
  top: 8px;
  display: flex;
  gap: 5px;
  align-items: center;
  background: rgba(18, 22, 27, 0.9);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 4px;
}

.canvas-tools button {
  padding: 2px 7px;
  font-size: 12px;
}

.zoom-label {
  font-size: 11px;
  color: var(--text-dim);
  padding: 0 4px;
  min-width: 42px;
  text-align: right;
}

.legend-panel {
  position: absolute;
  left: 8px;
  bottom: 8px;
  display: flex;
  gap: 12px;
  font-size: 11px;
  color: var(--text-dim);
  background: rgba(18, 22, 27, 0.9);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 5px 9px;
}

.legend-panel i {
  display: inline-block;
  width: 12px;
  height: 3px;
  border-radius: 2px;
  margin-right: 4px;
  vertical-align: middle;
}
</style>
