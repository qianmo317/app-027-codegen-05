<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type { Pt, Shape, Sheet } from '@/logic/types'
import type { ComputedShape } from '@/logic/pipeline'
import type { Job } from '@/logic/job'
import type { CutStep } from '@/logic/order'
import { closestOnPolyline, boundsOf, mergeBounds } from '@/logic/geometry'
import type { SheetPlacement } from '@/logic/exporters'
import { placePoint } from '@/logic/exporters'
import type { OverlayBridge, OverlayPath, OverlayTravel } from './overlay'

type Mode = 'outline' | 'toolpath' | 'bridge'
type Tool = 'select' | 'rect' | 'circle' | 'polygon' | 'bridge' | 'pan'

const props = withDefaults(
  defineProps<{
    shapes: Shape[]
    computed: Map<string, ComputedShape>
    job?: Job | null
    mode?: Mode
    tool?: Tool
    sheet?: Sheet | null
    showGrid?: boolean
    showNumbers?: boolean
    showTravel?: boolean
    magnify?: boolean
    selectedContourId?: string | null
    simPath?: Pt[] | null
    simIndex?: number
    placement?: SheetPlacement | null
    statusText?: string
    /** 版本对照叠加层：额外绘制的折线（坐标为原始 mm，按 placement 摆放） */
    overlayPaths?: OverlayPath[]
    overlayBridges?: OverlayBridge[]
    overlayTravels?: OverlayTravel[]
    /** 隐藏内置刀路/轮廓层（对照模式只显示叠加层时使用） */
    hideBuiltin?: boolean
    /** 定位标记（点清单条目后跳到该点） */
    focusMarker?: Pt | null
  }>(),
  {
    job: null,
    mode: 'outline',
    tool: 'select',
    sheet: null,
    showGrid: true,
    showNumbers: true,
    showTravel: true,
    magnify: true,
    selectedContourId: null,
    simPath: null,
    simIndex: -1,
    placement: null,
    statusText: '',
    overlayPaths: () => [],
    overlayBridges: () => [],
    overlayTravels: () => [],
    hideBuiltin: false,
    focusMarker: null,
  },
)

const emit = defineEmits<{
  selectContour: [id: string, shapeId: string]
  createRect: [r: { x: number; y: number; w: number; h: number }]
  createCircle: [c: { cx: number; cy: number; r: number }]
  createPolygon: [p: Pt[]]
  manualBridge: [p: { contourId: string; atIndex: number }]
  cursor: [p: Pt]
}>()

const wrap = ref<HTMLDivElement | null>(null)
const size = ref({ w: 800, h: 600 })
const zoom = ref(2.2)
const panX = ref(0)
const panY = ref(0)
const dragging = ref(false)
const dragStart = ref({ x: 0, y: 0 })
const draftRect = ref<{ x: number; y: number; w: number; h: number } | null>(null)
const draftCircle = ref<{ cx: number; cy: number; r: number } | null>(null)
const polyDraft = ref<Pt[]>([])
const hoverPt = ref<Pt | null>(null)
let ro: ResizeObserver | null = null

/** mm → 屏幕 px */
const toPx = (p: Pt): Pt => ({ x: p.x * zoom.value + panX.value, y: p.y * zoom.value + panY.value })

function contentBounds() {
  const list: ReturnType<typeof boundsOf>[] = []
  for (const s of props.shapes) {
    if (s.contours.length === 0) continue
    list.push(boundsOf(s.contours.flatMap((c) => c.points)))
  }
  if (props.sheet) list.push({ minX: 0, minY: 0, maxX: props.sheet.widthMm, maxY: props.sheet.heightMm })
  if (list.length === 0) return { minX: 0, minY: 0, maxX: 100, maxY: 100 }
  return mergeBounds(list)
}

const bounds = computed(() => contentBounds())

function fit(): void {
  const b = contentBounds()
  const pad = 24
  const w = Math.max(40, size.value.w - pad * 2)
  const h = Math.max(40, size.value.h - pad * 2)
  const bw = Math.max(1, b.maxX - b.minX)
  const bh = Math.max(1, b.maxY - b.minY)
  zoom.value = Math.min(w / bw, h / bh)
  panX.value = pad + (w - bw * zoom.value) / 2 - b.minX * zoom.value
  panY.value = pad + (h - bh * zoom.value) / 2 - b.minY * zoom.value
}

function zoomBy(f: number): void {
  const cx = size.value.w / 2
  const cy = size.value.h / 2
  const before = { x: (cx - panX.value) / zoom.value, y: (cy - panY.value) / zoom.value }
  zoom.value = Math.max(0.05, Math.min(200, zoom.value * f))
  panX.value = cx - before.x * zoom.value
  panY.value = cy - before.y * zoom.value
}

function localPoint(e: PointerEvent | MouseEvent): Pt {
  const el = wrap.value
  if (!el) return { x: 0, y: 0 }
  const r = el.getBoundingClientRect()
  return { x: e.clientX - r.left, y: e.clientY - r.top }
}

function toMm(p: Pt): Pt {
  return { x: (p.x - panX.value) / zoom.value, y: (p.y - panY.value) / zoom.value }
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
  window.addEventListener('keydown', onKey)
})

onUnmounted(() => {
  ro?.disconnect()
  window.removeEventListener('keydown', onKey)
})

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Enter' && polyDraft.value.length >= 3) finishPolygon()
  if (e.key === 'Escape') {
    polyDraft.value = []
    draftRect.value = null
    draftCircle.value = null
  }
}

watch(
  () => [props.shapes.length, props.mode],
  () => {
    if (props.shapes.length === 0) return
    fit()
  },
)
watch(
  () => props.tool,
  () => {
    polyDraft.value = []
    draftRect.value = null
    draftCircle.value = null
  },
)

function capture(id: number): void {
  try {
    wrap.value?.setPointerCapture(id)
  } catch {
    // 合成事件或非活动指针时 setPointerCapture 会抛错，忽略即可
  }
}

function onDown(e: PointerEvent): void {
  const px = localPoint(e)
  const mm = toMm(px)
  if (props.tool === 'pan' || e.button === 1) {
    dragging.value = true
    dragStart.value = { x: px.x - panX.value, y: px.y - panY.value }
    capture(e.pointerId)
    return
  }
  if (props.tool === 'rect') {
    dragging.value = true
    draftRect.value = { x: mm.x, y: mm.y, w: 0, h: 0 }
    capture(e.pointerId)
    return
  }
  if (props.tool === 'circle') {
    dragging.value = true
    draftCircle.value = { cx: mm.x, cy: mm.y, r: 0 }
    capture(e.pointerId)
    return
  }
  if (props.tool === 'polygon') {
    polyDraft.value.push({ x: round3(mm.x), y: round3(mm.y) })
    return
  }
  if (props.tool === 'bridge') {
    const hit = hitTest(mm)
    if (hit) {
      const c = closestOnPolyline(mm, hit.contour.points, hit.contour.closed)
      emit('manualBridge', { contourId: hit.contour.id, atIndex: c.index })
    }
    return
  }
  // select
  const hit = hitTest(mm)
  if (hit) emit('selectContour', hit.contour.id, hit.shape.id)
}

function onMove(e: PointerEvent): void {
  const px = localPoint(e)
  const mm = toMm(px)
  hoverPt.value = mm
  emit('cursor', { x: round3(mm.x), y: round3(mm.y) })
  if (!dragging.value) return
  if (props.tool === 'rect' && draftRect.value) {
    const s = draftRect.value
    draftRect.value = {
      x: Math.min(s.x + s.w, mm.x),
      y: Math.min(s.y + s.h, mm.y),
      w: Math.abs(mm.x - (s.x + s.w)),
      h: Math.abs(mm.y - (s.y + s.h)),
    }
    return
  }
  if (props.tool === 'circle' && draftCircle.value) {
    const c = draftCircle.value
    draftCircle.value = { cx: c.cx, cy: c.cy, r: Math.hypot(mm.x - c.cx, mm.y - c.cy) }
    return
  }
  if (props.tool === 'pan') {
    panX.value = px.x - dragStart.value.x
    panY.value = px.y - dragStart.value.y
  }
}

function onUp(): void {
  if (!dragging.value) return
  dragging.value = false
  if (props.tool === 'rect' && draftRect.value) {
    const r = draftRect.value
    draftRect.value = null
    if (r.w > 0.5 && r.h > 0.5) emit('createRect', { x: round3(r.x), y: round3(r.y), w: round3(r.w), h: round3(r.h) })
    return
  }
  if (props.tool === 'circle' && draftCircle.value) {
    const c = draftCircle.value
    draftCircle.value = null
    if (c.r > 0.5) emit('createCircle', { cx: round3(c.cx), cy: round3(c.cy), r: round3(c.r) })
  }
}

function onWheel(e: WheelEvent): void {
  e.preventDefault()
  const px = localPoint(e)
  const before = toMm(px)
  zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12)
  const after = toPx(before)
  panX.value += px.x - after.x
  panY.value += px.y - after.y
}

function finishPolygon(): void {
  if (polyDraft.value.length >= 3) emit('createPolygon', polyDraft.value.slice())
  polyDraft.value = []
}

function hitTest(mm: Pt): { shape: Shape; contour: Shape['contours'][number] } | null {
  const tol = 6 / zoom.value
  let best: { shape: Shape; contour: Shape['contours'][number]; d: number } | null = null
  for (const s of props.shapes) {
    for (const c of s.contours) {
      if (c.points.length < 2) continue
      const d = closestOnPolyline(mm, c.points, c.closed).distance
      if (d <= tol && (!best || d < best.d)) best = { shape: s, contour: c, d }
    }
  }
  return best ? { shape: best.shape, contour: best.contour } : null
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000
}

// ---------------- 渲染数据 ----------------

type DrawContour = {
  id: string
  shapeId: string
  d: string
  contour: Shape['contours'][number]
  color: string
  dash: string
  width: number
}

const WARNING_COLOR: Record<string, string> = {
  not_closed: '#ffc857',
  self_intersect: '#ff6b6b',
  duplicate: '#b48cff',
  offset_failed: '#ff6b6b',
  offset_clipped: '#5aa9ff',
  bridge_degraded: '#ff8f3c',
}

function pointsToD(pts: Pt[], closed: boolean): string {
  if (pts.length === 0) return ''
  let d = `M${pts[0].x.toFixed(3)} ${pts[0].y.toFixed(3)}`
  for (let i = 1; i < pts.length; i++) d += `L${pts[i].x.toFixed(3)} ${pts[i].y.toFixed(3)}`
  if (closed) d += 'Z'
  return d
}

const outlineContours = computed<DrawContour[]>(() => {
  const out: DrawContour[] = []
  for (const s of props.shapes) {
    for (const c of s.contours) {
      const bad = c.warnings.find((w) => w === 'self_intersect' || w === 'not_closed' || w === 'duplicate')
      out.push({
        id: c.id,
        shapeId: s.id,
        d: pointsToD(c.points, c.closed),
        contour: c,
        color: bad ? WARNING_COLOR[bad] : props.mode === 'bridge' ? '#4a5768' : '#cfd9e4',
        dash: bad === 'duplicate' ? '5 4' : bad === 'not_closed' ? '7 4' : '',
        width: c.id === props.selectedContourId ? 2.4 : 1.2,
      })
    }
  }
  return out
})

const pl = (p: Pt): Pt => (props.placement ? placePoint(p, props.placement) : p)

const cutSteps = computed<CutStep[]>(() => {
  if (props.job) return props.job.steps
  const out: CutStep[] = []
  for (const s of props.shapes) {
    const c = props.computed.get(s.id)
    if (!c) continue
    for (const st of c.order.steps) out.push(st)
  }
  return out
})

const cutPaths = computed(() =>
  cutSteps.value.map((st, i) => ({
    i,
    d: pointsToD(st.points.map(pl), st.closed),
    selected: st.contourId === props.selectedContourId,
  })),
)

const travels = computed(() => {
  const steps = cutSteps.value
  const out: Array<{ x1: number; y1: number; x2: number; y2: number }> = []
  for (let i = 1; i < steps.length; i++) {
    const a = pl(steps[i - 1].endPt)
    const b = pl(steps[i].startPt)
    out.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y })
  }
  return out
})

const numbers = computed(() => {
  if (!props.showNumbers) return []
  const steps = cutSteps.value
  const max = 120
  return steps.slice(0, max).map((st, i) => {
    const p = pl(st.startPt)
    return { i: i + 1, x: p.x, y: p.y, more: steps.length > max && i === max - 1 }
  })
})

/** 连刀点缺口（来自派生结果，用于放大视图） */
const bridges = computed(() => {
  const out: Array<{ x: number; y: number; end: Pt; widthMm: number; local: Pt[]; contourId: string }> = []
  for (const s of props.shapes) {
    const comp = props.computed.get(s.id)
    if (!comp) continue
    for (const c of s.contours) {
      const entry = comp.byId.get(c.id)
      if (!entry) continue
      for (const a of entry.anchors) {
        out.push({
          x: a.at.x,
          y: a.at.y,
          end: a.end,
          widthMm: a.widthMm,
          local: a.local,
          contourId: c.id,
        })
      }
    }
  }
  return out
})

const MAG = 8

/** 每个缺口对应的放大镜（屏幕坐标 + 局部几何屏幕坐标） */
const magnifiers = computed(() => {
  if (!props.magnify || props.mode !== 'bridge') return []
  const limit = 8
  return bridges.value.slice(0, limit).map((b, i) => {
    const anchor = toPx(pl({ x: b.x, y: b.y }))
    const center = { x: 62 + (i % 4) * 128, y: size.value.h - 74 - Math.floor(i / 4) * 128 }
    const local = b.local.map((p) => {
      const s = toPx(pl(p))
      return { x: center.x + (s.x - anchor.x) * MAG, y: center.y + (s.y - anchor.y) * MAG }
    })
    const endPx = toPx(pl(b.end))
    const gapA = { x: center.x, y: center.y }
    const gapB = { x: center.x + (endPx.x - anchor.x) * MAG, y: center.y + (endPx.y - anchor.y) * MAG }
    return { key: `${b.contourId}-${i}`, anchor, center, local, gapA, gapB, widthMm: b.widthMm, clipId: `magclip-${i}` }
  })
})

const simPts = computed(() => {
  if (!props.simPath || props.simPath.length === 0) return []
  return props.simPath.map((p) => toPx(pl(p)))
})

// ---------------- 版本对照叠加层 ----------------

const overlayPathData = computed(() =>
  props.overlayPaths.map((o) => ({
    ...o,
    d: pointsToD(o.points.map(pl), !!o.closed),
  })),
)

const overlayBridgeData = computed(() =>
  props.overlayBridges.map((b) => ({ ...b, atPx: toPx(pl(b.at)), endPx: toPx(pl(b.end)) })),
)

const overlayTravelData = computed(() =>
  props.overlayTravels.map((t) => ({ ...t, fromPx: toPx(pl(t.from)), toPx: toPx(pl(t.to)) })),
)

const focusMarkerPx = computed(() => (props.focusMarker ? toPx(pl(props.focusMarker)) : null))
const flash = ref(false)
let flashTimer: number | null = null

watch(
  () => props.focusMarker,
  () => {
    flash.value = true
    if (flashTimer !== null) window.clearTimeout(flashTimer)
    flashTimer = window.setTimeout(() => {
      flash.value = false
    }, 1600)
  },
)

const simHead = computed(() => {
  if (simPts.value.length === 0 || props.simIndex < 0) return null
  return simPts.value[Math.min(props.simIndex, simPts.value.length - 1)]
})

const donePath = computed(() => {
  if (simPts.value.length === 0 || props.simIndex < 0) return ''
  const cut = simPts.value.slice(0, Math.max(1, props.simIndex))
  return `M${cut.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join('L')}`
})

const gridLines = computed(() => {
  if (!props.showGrid) return { v: [] as number[], h: [] as number[], label: [] as Array<{ x: number; y: number; t: string }> }
  const b = bounds.value
  let step = 10
  const span = Math.max(b.maxX - b.minX, b.maxY - b.minY)
  if (span / step > 40) step = 50
  if (span / step < 6) step = 5
  const v: number[] = []
  const h: number[] = []
  const label: Array<{ x: number; y: number; t: string }> = []
  const x0 = Math.floor(b.minX / step) * step
  const y0 = Math.floor(b.minY / step) * step
  for (let x = x0; x <= b.maxX + step; x += step) {
    v.push(x)
    label.push({ x, y: b.minY, t: String(Math.round(x)) })
  }
  for (let y = y0; y <= b.maxY + step; y += step) {
    h.push(y)
    label.push({ x: b.minX, y, t: String(Math.round(y)) })
  }
  return { v, h, label }
})

defineExpose({ fit, zoomBy, zoom, focusContour, focusPoint })

/** 定位到任意 mm 坐标点（版本对照清单点击跳转） */
function focusPoint(p: Pt, zoomLevel?: number): void {
  const z = zoomLevel ?? Math.min(12, Math.max(zoom.value, 4))
  zoom.value = z
  panX.value = size.value.w / 2 - p.x * z
  panY.value = size.value.h / 2 - p.y * z
}

/** 屏幕坐标下的跳刀箭头（三角形指向落点） */
function arrowHead(from: Pt, to: Pt, size = 7): string {
  const ang = Math.atan2(to.y - from.y, to.x - from.x)
  const p1 = to
  const p2 = { x: to.x - size * Math.cos(ang - 0.42), y: to.y - size * Math.sin(ang - 0.42) }
  const p3 = { x: to.x - size * Math.cos(ang + 0.42), y: to.y - size * Math.sin(ang + 0.42) }
  return `${p1.x},${p1.y} ${p2.x},${p2.y} ${p3.x},${p3.y}`
}

function focusContour(id: string): void {
  for (const s of props.shapes) {
    for (const c of s.contours) {
      if (c.id !== id || c.points.length === 0) continue
      const b = boundsOf(c.points)
      const pad = 70
      const w = Math.max(40, size.value.w - pad * 2)
      const h = Math.max(40, size.value.h - pad * 2)
      const bw = Math.max(0.5, b.maxX - b.minX)
      const bh = Math.max(0.5, b.maxY - b.minY)
      zoom.value = Math.min(40, Math.min(w / bw, h / bh))
      const cx = (b.minX + b.maxX) / 2
      const cy = (b.minY + b.maxY) / 2
      panX.value = size.value.w / 2 - cx * zoom.value
      panY.value = size.value.h / 2 - cy * zoom.value
      return
    }
  }
}
</script>

<template>
  <div
    ref="wrap"
    class="canvas-wrap"
    role="application"
    aria-label="纹样刀路预览画布"
    data-testid="preview-canvas"
    tabindex="0"
    :style="{ cursor: tool === 'pan' ? 'grab' : tool === 'select' ? 'default' : 'crosshair' }"
  >
    <svg
      :width="size.w"
      :height="size.h"
      @pointerdown="onDown"
      @pointermove="onMove"
      @pointerup="onUp"
      @pointerleave="onUp"
      @wheel="onWheel"
      @dblclick="tool === 'polygon' && finishPolygon()"
    >
      <defs>
        <clipPath v-for="m in magnifiers" :id="m.clipId" :key="m.clipId">
          <circle :cx="m.center.x" :cy="m.center.y" r="56" />
        </clipPath>
      </defs>

      <g :transform="`translate(${panX} ${panY}) scale(${zoom})`">
        <!-- 网格 -->
        <g v-if="showGrid" stroke="#212a35" stroke-width="1" vector-effect="non-scaling-stroke">
          <line v-for="x in gridLines.v" :key="`gv${x}`" :x1="x" :y1="bounds.minY - 200" :x2="x" :y2="bounds.maxY + 200" />
          <line v-for="y in gridLines.h" :key="`gh${y}`" :x1="bounds.minX - 200" :y1="y" :x2="bounds.maxX + 200" :y2="y" />
        </g>

        <!-- 纸幅 -->
        <rect
          v-if="sheet"
          :x="0"
          :y="0"
          :width="sheet.widthMm"
          :height="sheet.heightMm"
          fill="#151a20"
          stroke="#3a4654"
          stroke-width="1.5"
          vector-effect="non-scaling-stroke"
        />

        <!-- 成品轮廓 -->
        <g v-if="!hideBuiltin && (mode === 'outline' || mode === 'bridge' || !job)" fill="none" stroke-linecap="round" stroke-linejoin="round">
          <path
            v-for="c in outlineContours"
            :key="c.id"
            :d="c.d"
            :stroke="c.color"
            :stroke-dasharray="c.dash"
            :stroke-width="c.width"
            vector-effect="non-scaling-stroke"
          />
        </g>

        <!-- 刀路（切割顺序） -->
        <g v-if="!hideBuiltin && mode === 'toolpath'" fill="none" stroke-linecap="round" stroke-linejoin="round">
          <path
            v-for="p in cutPaths"
            :key="`cut${p.i}`"
            :d="p.d"
            :stroke="p.selected ? '#47c07a' : '#ff8f3c'"
            :stroke-width="p.selected ? 2.4 : 1.7"
            vector-effect="non-scaling-stroke"
          />
        </g>

        <!-- 跳刀 -->
        <g v-if="!hideBuiltin && showTravel && mode === 'toolpath'" stroke="#7f8fa3" stroke-width="1" stroke-dasharray="4 4" vector-effect="non-scaling-stroke">
          <line v-for="(t, i) in travels" :key="`t${i}`" :x1="t.x1" :y1="t.y1" :x2="t.x2" :y2="t.y2" />
        </g>

        <!-- 顺序编号 -->
        <g v-if="!hideBuiltin && mode === 'toolpath' && showNumbers">
          <g v-for="n in numbers" :key="`n${n.i}`">
            <circle :cx="n.x" :cy="n.y" :r="7 / zoom" fill="#12161b" stroke="#ff8f3c" :stroke-width="1.4 / zoom" />
            <text
              :x="n.x"
              :y="n.y + 2.6 / zoom"
              :font-size="8 / zoom"
              text-anchor="middle"
              fill="#ffb066"
              font-family="Plotter Mono, monospace"
            >
              {{ n.i }}
            </text>
          </g>
        </g>

        <!-- 连刀点缺口标记 -->
        <g v-if="!hideBuiltin && mode === 'bridge'">
          <g v-for="(b, i) in bridges" :key="`b${i}`">
            <circle :cx="b.x" :cy="b.y" :r="2.4 / zoom" fill="#47c07a" />
            <circle :cx="b.end.x" :cy="b.end.y" :r="2.4 / zoom" fill="#47c07a" />
            <line :x1="b.x" :y1="b.y" :x2="b.end.x" :y2="b.end.y" stroke="#47c07a" :stroke-width="1.4 / zoom" />
          </g>
        </g>

        <!-- 仿真轨迹 -->
        <g v-if="simPts.length > 0" fill="none">
          <path :d="donePath" stroke="#47c07a" stroke-width="1.6" vector-effect="non-scaling-stroke" />
          <circle v-if="simHead" :cx="simHead.x" :cy="simHead.y" :r="5 / zoom" fill="#ff6b6b" stroke="#fff" :stroke-width="1 / zoom" />
        </g>

        <!-- 版本对照：跳刀叠加层 -->
        <g fill="none">
          <g v-for="t in overlayTravelData" :key="t.key">
            <line
              :x1="t.fromPx.x"
              :y1="t.fromPx.y"
              :x2="t.toPx.x"
              :y2="t.toPx.y"
              :stroke="t.color"
              :stroke-width="t.emphasis ? 2 : 1.2"
              :stroke-dasharray="t.dashed === false ? '' : '5 4'"
              :opacity="t.emphasis ? 1 : 0.75"
              vector-effect="non-scaling-stroke"
            />
            <polygon
              v-if="t.emphasis"
              :points="arrowHead(t.fromPx, t.toPx)"
              :fill="t.color"
            />
          </g>
        </g>

        <!-- 版本对照：刀路叠加层 -->
        <g fill="none" stroke-linecap="round" stroke-linejoin="round">
          <path
            v-for="o in overlayPathData"
            :key="o.key"
            :d="o.d"
            :stroke="o.color"
            :stroke-width="o.emphasis ? 2.6 : o.width ?? 1.4"
            :stroke-dasharray="o.dash ?? ''"
            :opacity="o.opacity ?? 1"
            vector-effect="non-scaling-stroke"
          />
        </g>

        <!-- 版本对照：连刀点叠加层 -->
        <g v-if="overlayBridgeData.length > 0">
          <g v-for="b in overlayBridgeData" :key="b.key">
            <line
              :x1="b.atPx.x"
              :y1="b.atPx.y"
              :x2="b.endPx.x"
              :y2="b.endPx.y"
              :stroke="b.color"
              :stroke-width="(b.emphasis ? 2 : 1.2) / zoom"
            />
            <circle :cx="b.atPx.x" :cy="b.atPx.y" :r="(b.emphasis ? 3 : 2) / zoom" :fill="b.color" />
            <circle :cx="b.endPx.x" :cy="b.endPx.y" :r="(b.emphasis ? 3 : 2) / zoom" :fill="b.color" />
          </g>
        </g>

        <!-- 绘制中的草稿 -->
        <g v-if="draftRect" fill="none" stroke="#5aa9ff" stroke-width="1.6" vector-effect="non-scaling-stroke">
          <rect :x="draftRect.x" :y="draftRect.y" :width="draftRect.w" :height="draftRect.h" />
        </g>
        <g v-if="draftCircle" fill="none" stroke="#5aa9ff" stroke-width="1.6" vector-effect="non-scaling-stroke">
          <circle :cx="draftCircle.cx" :cy="draftCircle.cy" :r="draftCircle.r" />
        </g>
        <g v-if="polyDraft.length > 0" fill="none" stroke="#5aa9ff" stroke-width="1.6" vector-effect="non-scaling-stroke">
          <polyline :points="[...polyDraft, hoverPt].filter(Boolean).map((p) => `${p!.x},${p!.y}`).join(' ')" />
          <circle v-for="(p, i) in polyDraft" :key="`pd${i}`" :cx="p.x" :cy="p.y" :r="1.6 / zoom" fill="#5aa9ff" />
        </g>
      </g>

      <!-- 连刀点放大视图（8 倍） -->
      <g v-for="m in magnifiers" :key="m.key">
        <line
          :x1="m.anchor.x"
          :y1="m.anchor.y"
          :x2="m.center.x"
          :y2="m.center.y"
          stroke="#47c07a"
          stroke-width="1"
          stroke-dasharray="3 3"
          opacity="0.7"
        />
        <circle :cx="m.center.x" :cy="m.center.y" r="56" fill="#0d1116" stroke="#ff8f3c" stroke-width="1.6" />
        <g :clip-path="`url(#${m.clipId})`">
          <polyline
            :points="m.local.map((p) => `${p.x},${p.y}`).join(' ')"
            fill="none"
            stroke="#cfd9e4"
            stroke-width="1.6"
          />
          <line :x1="m.gapA.x" :y1="m.gapA.y" :x2="m.gapB.x" :y2="m.gapB.y" stroke="#47c07a" stroke-width="2.4" />
          <circle :cx="m.gapA.x" :cy="m.gapA.y" r="3" fill="#47c07a" />
          <circle :cx="m.gapB.x" :cy="m.gapB.y" r="3" fill="#47c07a" />
        </g>
        <text :x="m.center.x" :y="m.center.y + 68" font-size="10" text-anchor="middle" fill="#93a3b4" font-family="Plotter Mono, monospace">
          {{ m.widthMm.toFixed(2) }}mm ×8
        </text>
      </g>

      <!-- 定位标记（点差异清单跳转） -->
      <g v-if="focusMarkerPx">
        <circle
          :cx="focusMarkerPx.x"
          :cy="focusMarkerPx.y"
          r="10"
          fill="none"
          stroke="#ffe14d"
          stroke-width="2"
          :class="flash ? 'marker-pulse' : ''"
        />
        <circle :cx="focusMarkerPx.x" :cy="focusMarkerPx.y" r="2.5" fill="#ffe14d" />
        <line :x1="focusMarkerPx.x - 14" :y1="focusMarkerPx.y" :x2="focusMarkerPx.x + 14" :y2="focusMarkerPx.y" stroke="#ffe14d" stroke-width="1" opacity="0.8" />
        <line :x1="focusMarkerPx.x" :y1="focusMarkerPx.y - 14" :x2="focusMarkerPx.x" :y2="focusMarkerPx.y + 14" stroke="#ffe14d" stroke-width="1" opacity="0.8" />
      </g>
    </svg>

    <div class="canvas-tools no-print">
      <button class="tiny" title="缩小" @click="zoomBy(1 / 1.2)">−</button>
      <button class="tiny" title="放大" @click="zoomBy(1.2)">＋</button>
      <button class="tiny" title="适应窗口" @click="fit">适应</button>
      <span class="zoom-label mono">{{ (zoom * 100).toFixed(0) }}%</span>
    </div>

    <div v-if="tool === 'polygon' && polyDraft.length > 0" class="canvas-hint no-print">
      已放置 {{ polyDraft.length }} 个点｜回车或双击完成
      <button class="tiny" @click="finishPolygon">完成</button>
    </div>

    <div class="canvas-hud no-print">
      <span v-if="statusText" class="tag">{{ statusText }}</span>
      <span class="tag mono">缩放 {{ (zoom * 100).toFixed(0) }}%</span>
    </div>
  </div>
</template>

<style scoped>
.canvas-wrap {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  background: var(--bg-grid);
  overflow: hidden;
  touch-action: none;
}

.canvas-wrap svg {
  display: block;
}

.canvas-hint {
  position: absolute;
  left: 50%;
  top: 8px;
  transform: translateX(-50%);
  background: rgba(18, 22, 27, 0.92);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 4px 8px;
  font-size: 12px;
  display: flex;
  align-items: center;
  gap: 6px;
}

.zoom-label {
  font-size: 11px;
  color: var(--text-dim);
  padding: 0 4px;
  min-width: 42px;
  text-align: right;
}

.marker-pulse {
  animation: marker-pulse 0.8s ease-in-out 2;
}

@keyframes marker-pulse {
  0%,
  100% {
    r: 10;
    opacity: 1;
  }
  50% {
    r: 18;
    opacity: 0.35;
  }
}
</style>