import { reactive } from 'vue'
import type { BatchCfg, CutSettings, ExportCfg, MaterialPreset, Pt, Sheet } from './types'
import type { Job, JobStep } from './job'
import { boundsOf, dist, uid } from './geometry'
import { downloadText, sanitizeFilename } from './download'

/**
 * 刀路版本对照：
 * - 每导出（或手动存档）一版，把整场（多形状 / 多图层 / 批量排版）刀路连同
 *   当时的切割参数、导出设置、连刀点位置一起冻结成快照；
 * - 选两版比对：只在一版出现的切割段、连刀点增删/移位、跳刀走向变化，
 *   以及刀路总长 / 跳刀总长 / 预计切割时间三项差值；
 * - 差异清单可导出文本，点条目可在图上定位；
 * - 版本攒多了可只留最近若干版：正在比对的版本受保护不许删。
 */

// ---------------- 快照数据模型 ----------------

/** 存档用的单段刀路（点数摊平为 [x0,y0,x1,y1,...]，坐标保留 0.001mm） */
export type VersionStep = {
  seq: number
  contourId: string
  shapeId: string
  shapeName: string
  shapeLayer: number
  runIndex: number
  runCount: number
  closed: boolean
  /** 摊平坐标，单位 mm（内部坐标，未做纸幅摆放） */
  f: number[]
  lengthMm: number
  /** 从上一段末尾跳到本段起点的距离 */
  travelMm: number
}

export type VersionParams = {
  order: CutSettings['order']
  bridgeRule: CutSettings['bridgeRule']
  areaThresholdMm2: number
  bridgeWidthMm: number
  bridgeEveryMm: number
  travelOptimize: CutSettings['travelOptimize']
  toleranceMm: number
  closeToleranceMm: number
  useBladeOffset: boolean
  /** 材料相关（影响刀补 / 时间） */
  materialId: string
  materialName: string
  materialPaper: string
  materialForce: number
  materialSpeedMmS: number
  materialPasses: number
  materialBladeOffsetMm: number
  /** 导出设置（存档时的格式 / 缩放 / 纸幅） */
  exportFormat: ExportCfg['format']
  exportScale: number
  exportOrigin: ExportCfg['origin']
  sheetName: string
  sheetWidthMm: number
  sheetHeightMm: number
  /** 批量排版：整场按排版结果存 */
  batchEnabled: boolean
  batchRows: number
  batchCols: number
  batchGapXMm: number
  batchGapYMm: number
  batchSharedEdge: boolean
  batchMode: BatchCfg['mode']
}

/** 存档时的连刀点（由切割段反推：同轮廓相邻段的首尾缺口） */
export type VersionBridge = {
  id: number
  contourId: string
  shapeId: string
  a: Pt
  b: Pt
  /** 缺口物理宽度（mm） */
  widthMm: number
  seqBefore: number
  seqAfter: number
}

/** 存档时的一次跳刀（抬刀空移） */
export type VersionTravel = {
  id: number
  seqAfter: number
  from: Pt
  to: Pt
  lengthMm: number
  shapeId: string
}

export type VersionStats = {
  cutLengthMm: number
  travelMm: number
  /** 预计切割时间（s）= 刀路总长 × 重复次数 / 切割速度 */
  cutTimeSec: number
  runCount: number
  bridgeCount: number
  shapeCount: number
  layerCount: number
  bbox: { minX: number; minY: number; maxX: number; maxY: number }
}

export type ToolpathVersion = {
  id: string
  label: string
  note: string
  createdAt: number
  /** 存档时的导出格式 */
  exportFormat: ExportCfg['format']
  params: VersionParams
  stats: VersionStats
  steps: VersionStep[]
  bridges: VersionBridge[]
  travels: VersionTravel[]
  /** 去重签名：刀路坐标 + 参数完全一致时相同 */
  signature: string
}

export type VersionSaveOutcome =
  | { status: 'saved'; version: ToolpathVersion; duplicated: boolean }
  | { status: 'empty' }
  | { status: 'error'; message: string }

// ---------------- 预计切割时间 ----------------

/** 预计切割时间（秒）：切割总长 × 重复次数 ÷ 速度（跳刀按快速移动，另计占比很小，不单列） */
export function estimateCutTimeSec(cutLengthMm: number, material: MaterialPreset | null): number {
  const speed = material?.speedMmS ?? 40
  const passes = Math.max(1, material?.passes ?? 1)
  if (speed <= 0) return 0
  return (cutLengthMm * passes) / speed
}

// ---------------- 由 Job 生成快照 ----------------

function flatten(points: Pt[]): number[] {
  const out: number[] = new Array(points.length * 2)
  for (let i = 0; i < points.length; i++) {
    out[i * 2] = Math.round(points[i].x * 1000) / 1000
    out[i * 2 + 1] = Math.round(points[i].y * 1000) / 1000
  }
  return out
}

export function stepPoints(s: VersionStep): Pt[] {
  const out: Pt[] = new Array(s.f.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = { x: s.f[i * 2], y: s.f[i * 2 + 1] }
  return out
}

function stepEnd(s: VersionStep): Pt {
  return { x: s.f[s.f.length - 2], y: s.f[s.f.length - 1] }
}
function stepStart(s: VersionStep): Pt {
  return { x: s.f[0], y: s.f[1] }
}

/** 反转摊平点序列（x,y 成对翻转，保持坐标配对） */
function reverseFlat(f: number[]): void {
  const pairs: number[] = []
  for (let i = f.length - 2; i >= 0; i -= 2) pairs.push(f[i], f[i + 1])
  for (let i = 0; i < f.length; i++) f[i] = pairs[i]
}

/** 由切割段反推连刀点：同一轮廓的多段之间，段尾 → 下段头即缺口 */
function extractBridges(steps: VersionStep[]): VersionBridge[] {
  const out: VersionBridge[] = []
  let bid = 0
  const byContour = new Map<string, VersionStep[]>()
  for (const st of steps) {
    const arr = byContour.get(st.contourId)
    if (arr) arr.push(st)
    else byContour.set(st.contourId, [st])
  }
  /** 缺口最大物理宽度不会太离谱（mm），超过这个距离的「口子」一定不是连刀点 */
  const GAP_MAX = 8

  for (const arr of byContour.values()) {
    arr.sort((a, b) => a.runIndex - b.runIndex || a.seq - b.seq)

    // 共边裁切会把同一 run 拆成多段（runIndex 相同、端点相接），先按空间接起来
    const runs: VersionStep[][] = []
    for (const st of arr) {
      const bucket = runs.find((r) => r[0].runIndex === st.runIndex)
      if (bucket) bucket.push(st)
      else runs.push([st])
    }
    const runEnds: Pt[] = []
    const runStarts: Pt[] = []
    for (const r of runs) {
      // 同 runIndex 内可能被共边裁切拆成多段：按端点相接链接成一条
      const pieces = r.slice()
      const ordered: VersionStep[] = []
      if (pieces.length > 1) {
        ordered.push(pieces.shift()!)
        while (pieces.length > 0) {
          const tail = stepEnd(ordered[ordered.length - 1])
          let bi = 0
          let bd = Infinity
          for (let i = 0; i < pieces.length; i++) {
            const d = Math.min(dist(tail, stepStart(pieces[i])), dist(tail, stepEnd(pieces[i])))
            if (d < bd) {
              bd = d
              bi = i
            }
          }
          const piece = pieces.splice(bi, 1)[0]
          if (dist(tail, stepEnd(piece)) < dist(tail, stepStart(piece))) reverseFlat(piece.f)
          ordered.push(piece)
        }
      } else {
        ordered.push(pieces[0])
      }
      r.length = 0
      r.push(...ordered)
      runStarts.push(stepStart(r[0]))
      runEnds.push(stepEnd(r[r.length - 1]))
    }

    const addGap = (a: Pt, b: Pt, seqA: number, seqB: number, src: VersionStep) => {
      const w = dist(a, b)
      if (w <= 0.02 || w > GAP_MAX) return
      out.push({
        id: bid++,
        contourId: src.contourId,
        shapeId: src.shapeId,
        a,
        b,
        widthMm: Math.round(w * 1000) / 1000,
        seqBefore: seqA,
        seqAfter: seqB,
      })
    }

    if (runs.length === 1) {
      // 只有一个 run：闭合 run 无缺口；开口 run（单缺口）缺口在首尾之间
      const r = runs[0]
      if (!r.some((s) => s.closed)) addGap(runEnds[0], runStarts[0], r[r.length - 1].seq, r[0].seq, r[0])
      continue
    }

    // 多 run = 连刀点把闭合轮廓切成多段：每个 run 的尾 → 空间最近的另一个 run 的头是一个缺口
    const usedStart = new Set<number>()
    for (let i = 0; i < runs.length; i++) {
      const end = runEnds[i]
      let best = -1
      let bestD = Infinity
      for (let j = 0; j < runs.length; j++) {
        if (i === j || usedStart.has(j)) continue
        const d = dist(end, runStarts[j])
        if (d < bestD) {
          bestD = d
          best = j
        }
      }
      if (best >= 0) {
        usedStart.add(best)
        addGap(end, runStarts[best], runs[i][runs[i].length - 1].seq, runs[best][0].seq, runs[i][0])
      }
    }
  }
  out.sort((a, b) => a.seqBefore - b.seqBefore || a.seqAfter - b.seqAfter)
  return out.map((b, i) => ({ ...b, id: i }))
}

function extractTravels(steps: VersionStep[]): VersionTravel[] {
  const sorted = steps.slice().sort((a, b) => a.seq - b.seq)
  const out: VersionTravel[] = []
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]
    const cur = sorted[i]
    if (cur.travelMm <= 1e-6) continue
    out.push({
      id: i - 1,
      seqAfter: cur.seq,
      from: stepEnd(prev),
      to: stepStart(cur),
      lengthMm: Math.round(cur.travelMm * 1000) / 1000,
      shapeId: cur.shapeId,
    })
  }
  return out
}

export type SnapshotInputs = {
  job: Job
  settings: CutSettings
  exportCfg: ExportCfg
  sheet: Sheet
  material: MaterialPreset | null
  batch?: BatchCfg
  label?: string
  note?: string
  exportFormat?: ExportCfg['format']
}

function buildParams(inp: SnapshotInputs): VersionParams {
  const s = inp.settings
  const m = inp.material
  const b = inp.batch
  return {
    order: s.order,
    bridgeRule: s.bridgeRule,
    areaThresholdMm2: s.areaThresholdMm2,
    bridgeWidthMm: s.bridgeWidthMm,
    bridgeEveryMm: s.bridgeEveryMm,
    travelOptimize: s.travelOptimize,
    toleranceMm: s.toleranceMm,
    closeToleranceMm: s.closeToleranceMm,
    useBladeOffset: s.useBladeOffset,
    materialId: m?.id ?? '',
    materialName: m?.name ?? '（无材料）',
    materialPaper: m?.paper ?? '',
    materialForce: m?.force ?? 0,
    materialSpeedMmS: m?.speedMmS ?? 0,
    materialPasses: m?.passes ?? 1,
    materialBladeOffsetMm: m?.bladeOffsetMm ?? 0,
    exportFormat: inp.exportFormat ?? inp.exportCfg.format,
    exportScale: inp.exportCfg.scale,
    exportOrigin: inp.exportCfg.origin,
    sheetName: inp.sheet.name,
    sheetWidthMm: inp.sheet.widthMm,
    sheetHeightMm: inp.sheet.heightMm,
    batchEnabled: !!b?.enabled,
    batchRows: b?.rows ?? 0,
    batchCols: b?.cols ?? 0,
    batchGapXMm: b?.gapXMm ?? 0,
    batchGapYMm: b?.gapYMm ?? 0,
    batchSharedEdge: !!b?.sharedEdge,
    batchMode: b?.mode ?? 'repeat',
  }
}

function versionSignature(steps: VersionStep[], params: VersionParams): string {
  let h = 2166136261
  const mix = (v: number | string | boolean) => {
    const str = typeof v === 'number' ? Math.round(v * 1000).toString(36) : String(v)
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
    h ^= 0x7c
  }
  for (const st of steps) {
    mix(st.contourId)
    for (let i = 0; i < st.f.length; i++) mix(st.f[i])
  }
  Object.values(params).forEach(mix)
  return (h >>> 0).toString(36)
}

function defaultLabel(date: Date, seq: number): string {
  const p2 = (n: number) => String(n).padStart(2, '0')
  return `${date.getMonth() + 1}月${date.getDate()}日 ${p2(date.getHours())}:${p2(date.getMinutes())} 第 ${seq} 版`
}

/** 由当前整场 Job 构建一个冻结版本（不落盘） */
export function buildVersion(inp: SnapshotInputs, seqOfDay: number): ToolpathVersion | null {
  if (inp.job.steps.length === 0) return null
  const steps: VersionStep[] = inp.job.steps.map((st: JobStep) => ({
    seq: st.seq,
    contourId: st.contourId,
    shapeId: st.shapeId,
    shapeName: st.shapeName,
    shapeLayer: st.shapeLayer,
    runIndex: st.runIndex,
    runCount: st.runCount,
    closed: st.closed,
    f: flatten(st.points),
    lengthMm: Math.round(st.lengthMm * 1000) / 1000,
    travelMm: Math.round(st.travelFromPrevMm * 1000) / 1000,
  }))
  const bridges = extractBridges(steps)
  const travels = extractTravels(steps)
  const params = buildParams(inp)
  const allPts = steps.flatMap(stepPoints)
  const shapeIds = new Set(steps.map((s) => s.shapeId))
  const layerIds = new Set(steps.map((s) => s.shapeLayer))
  const now = new Date()
  const stats: VersionStats = {
    cutLengthMm: Math.round(inp.job.cutLengthMm * 1000) / 1000,
    travelMm: Math.round(inp.job.travelMm * 1000) / 1000,
    cutTimeSec: Math.round(estimateCutTimeSec(inp.job.cutLengthMm, inp.material) * 10) / 10,
    runCount: steps.length,
    bridgeCount: bridges.length,
    shapeCount: shapeIds.size,
    layerCount: layerIds.size,
    bbox: boundsOf(allPts),
  }
  const v: ToolpathVersion = {
    id: uid('tv'),
    label: inp.label?.trim() || defaultLabel(now, seqOfDay),
    note: inp.note ?? '',
    createdAt: Date.now(),
    exportFormat: params.exportFormat,
    params,
    stats,
    steps,
    bridges,
    travels,
    signature: '',
  }
  v.signature = versionSignature(steps, params)
  return v
}

// ---------------- 差异比对 ----------------

export type DiffSide = 'a' | 'b'
export type DiffKind = 'seg_only_a' | 'seg_only_b' | 'bridge' | 'travel'

export type DiffEntry = {
  id: string
  kind: DiffKind
  /** 变化类型（细分）：切割段新增/消失；连刀点 新增/消失/移位；跳刀 新增/消失/走向变化 */
  change: string
  title: string
  detail: string
  side: DiffSide
  /** 图上定位点（mm，内部坐标） */
  focus: Pt
  /** 定位视野范围（mm） */
  bounds: { minX: number; minY: number; maxX: number; maxY: number }
}

export type SegMark = { step: VersionStep; onlyHere: boolean }

export type VersionDiff = {
  a: ToolpathVersion
  b: ToolpathVersion
  /** 每段是否只在本版出现 */
  marksA: Map<number, boolean>
  marksB: Map<number, boolean>
  onlyASegments: VersionStep[]
  onlyBSegments: VersionStep[]
  entries: DiffEntry[]
  bridgeAdded: VersionBridge[]
  bridgeRemoved: VersionBridge[]
  bridgeMoved: Array<{ from: VersionBridge; to: VersionBridge; distanceMm: number }>
  travelAdded: VersionTravel[]
  travelRemoved: VersionTravel[]
  travelRerouted: Array<{ from: VersionTravel; to: VersionTravel; moveMm: number }>
  metrics: {
    cutDeltaMm: number
    travelDeltaMm: number
    cutTimeDeltaSec: number
  }
  changedParams: Array<{ key: keyof VersionParams; label: string; a: string; b: string }>
  identical: boolean
}

/** 采样一条折线（含闭合边），间距 ≤ spacing */
function sampleStep(s: VersionStep, spacing: number): Pt[] {
  const pts = stepPoints(s)
  const out: Pt[] = []
  const n = pts.length
  const segCount = s.closed ? n : Math.max(0, n - 1)
  for (let i = 0; i < segCount; i++) {
    const p = pts[i]
    const q = pts[(i + 1) % n]
    const len = dist(p, q)
    const k = Math.max(1, Math.ceil(len / spacing))
    for (let j = 0; j < k; j++) {
      const t = j / k
      out.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t })
    }
  }
  if (!s.closed && n > 0) out.push(pts[n - 1])
  return out
}

type Grid = Map<number, Pt[]>

function buildGrid(points: Pt[], cell: number): Grid {
  const g: Grid = new Map()
  const key = (cx: number, cy: number) => cy * 1000003 + cx
  for (const p of points) {
    const cx = Math.floor(p.x / cell)
    const cy = Math.floor(p.y / cell)
    const k = key(cx, cy)
    const arr = g.get(k)
    if (arr) arr.push(p)
    else g.set(k, [p])
  }
  return g
}

function gridHasNear(g: Grid, p: Pt, cell: number, radius: number): boolean {
  const cx = Math.floor(p.x / cell)
  const cy = Math.floor(p.y / cell)
  const r = Math.ceil(radius / cell)
  const r2 = radius * radius
  for (let dx = -r; dx <= r; dx++) {
    for (let dy = -r; dy <= r; dy++) {
      const arr = g.get((cy + dy) * 1000003 + (cx + dx))
      if (!arr) continue
      for (const q of arr) {
        const ddx = q.x - p.x
        const ddy = q.y - p.y
        if (ddx * ddx + ddy * ddy <= r2) return true
      }
    }
  }
  return false
}

/**
 * 切割段比对：对每段做等距采样，若足够多采样点在另一版刀路附近（半径内），
 * 认为该段两版共有；否则标记为只在本版出现。段被缺口切开 / 合并也能正确归类。
 */
function markSegments(a: ToolpathVersion, b: ToolpathVersion): { onlyA: VersionStep[]; onlyB: VersionStep[]; ma: Map<number, boolean>; mb: Map<number, boolean> } {
  const CELL = 0.5
  const RADIUS = 0.25
  const SPACING = 0.6
  const gridB = buildGrid(b.steps.flatMap((s) => sampleStep(s, SPACING)), CELL)
  const gridA = buildGrid(a.steps.flatMap((s) => sampleStep(s, SPACING)), CELL)

  const onlyA: VersionStep[] = []
  const onlyB: VersionStep[] = []
  const ma = new Map<number, boolean>()
  const mb = new Map<number, boolean>()

  for (const s of a.steps) {
    const samples = sampleStep(s, SPACING)
    let hit = 0
    for (const p of samples) if (gridHasNear(gridB, p, CELL, RADIUS)) hit += 1
    const ratio = samples.length ? hit / samples.length : 1
    const only = ratio < 0.7
    ma.set(s.seq, only)
    if (only) onlyA.push(s)
  }
  for (const s of b.steps) {
    const samples = sampleStep(s, SPACING)
    let hit = 0
    for (const p of samples) if (gridHasNear(gridA, p, CELL, RADIUS)) hit += 1
    const ratio = samples.length ? hit / samples.length : 1
    const only = ratio < 0.7
    mb.set(s.seq, only)
    if (only) onlyB.push(s)
  }
  return { onlyA, onlyB, ma, mb }
}

function padBounds(b: { minX: number; minY: number; maxX: number; maxY: number }, pad: number) {
  return { minX: b.minX - pad, minY: b.minY - pad, maxX: b.maxX + pad, maxY: b.maxY + pad }
}

/** 把相邻（端点相接）的独有段聚成条目，避免一条长轮廓变几十条清单 */
function groupSegments(segs: VersionStep[], side: DiffSide, sign: 1 | -1): DiffEntry[] {
  if (segs.length === 0) return []
  const groups: VersionStep[][] = []
  const used = new Set<number>()
  const byKey = new Map<string, VersionStep>()
  const keyOf = (p: Pt) => `${Math.round(p.x * 50)},${Math.round(p.y * 50)}`
  for (const s of segs) {
    byKey.set(`start:${keyOf(stepStart(s))}`, s)
    byKey.set(`end:${keyOf(stepEnd(s))}`, s)
  }
  for (const s of segs) {
    if (used.has(s.seq)) continue
    const group: VersionStep[] = [s]
    used.add(s.seq)
    // 向后 / 向前接上端点
    let frontier = s
    for (;;) {
      const nxt = byKey.get(`start:${keyOf(stepEnd(frontier))}`)
      if (!nxt || used.has(nxt.seq)) break
      used.add(nxt.seq)
      group.push(nxt)
      frontier = nxt
    }
    frontier = s
    for (;;) {
      const prv = byKey.get(`end:${keyOf(stepStart(frontier))}`)
      if (!prv || used.has(prv.seq)) break
      used.add(prv.seq)
      group.unshift(prv)
      frontier = prv
    }
    groups.push(group)
  }
  return groups.map((g, i) => {
    const allPts = g.flatMap(stepPoints)
    const b = boundsOf(allPts)
    const len = g.reduce((acc, s) => acc + s.lengthMm, 0)
    const first = g[0]
    const last = g[g.length - 1]
    const verb = sign > 0 ? '新增切割段' : '消失切割段'
    return {
      id: `seg-${side}-${i}`,
      kind: sign > 0 ? 'seg_only_b' : 'seg_only_a',
      change: verb,
      title: `${verb} · ${first.shapeName}（#${first.seq}${g.length > 1 ? `~#${last.seq}` : ''}）`,
      detail: `${g.length} 段相连｜约 ${len.toFixed(2)}mm｜图层 ${first.shapeLayer + 1}`,
      side,
      focus: stepStart(first),
      bounds: padBounds(b, Math.max(3, (b.maxX - b.minX) * 0.15)),
    }
  })
}

type Pairing<T> = { matched: Array<{ a: T; b: T; d: number }>; onlyA: T[]; onlyB: T[] }

/** 贪心最近配对：每次取全局距离最小的一对 */
function nearestPair<T>(listA: T[], listB: T[], distFn: (x: T, y: T) => number, maxDist: number): Pairing<T> {
  const pairs: Array<{ i: number; j: number; d: number }> = []
  for (let i = 0; i < listA.length; i++) {
    for (let j = 0; j < listB.length; j++) {
      const d = distFn(listA[i], listB[j])
      if (d <= maxDist) pairs.push({ i, j, d })
    }
  }
  pairs.sort((x, y) => x.d - y.d)
  const usedA = new Set<number>()
  const usedB = new Set<number>()
  const matched: Array<{ a: T; b: T; d: number }> = []
  for (const p of pairs) {
    if (usedA.has(p.i) || usedB.has(p.j)) continue
    usedA.add(p.i)
    usedB.add(p.j)
    matched.push({ a: listA[p.i], b: listB[p.j], d: p.d })
  }
  return {
    matched,
    onlyA: listA.filter((_, i) => !usedA.has(i)),
    onlyB: listB.filter((_, j) => !usedB.has(j)),
  }
}

function midpoint(a: Pt, b: Pt): Pt {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

/** 连刀点配对：中心位置在阈值内算同一个；宽度差异也算移位 */
function diffBridges(a: ToolpathVersion, b: ToolpathVersion): {
  added: VersionBridge[]
  removed: VersionBridge[]
  moved: Array<{ from: VersionBridge; to: VersionBridge; distanceMm: number }>
  entries: DiffEntry[]
} {
  const center = (br: VersionBridge) => midpoint(br.a, br.b)
  const maxDist = Math.max(1.0, a.params.bridgeWidthMm * 2, b.params.bridgeWidthMm * 2)
  const pairing = nearestPair(a.bridges, b.bridges, (x, y) => dist(center(x), center(y)), maxDist)

  const removed = pairing.onlyA
  const added = pairing.onlyB
  const moved = pairing.matched
    .filter(({ a: x, b: y, d }) => d > 0.05 || Math.abs(x.widthMm - y.widthMm) > 0.05)
    .map(({ a: x, b: y, d }) => ({ from: x, to: y, distanceMm: Math.round(d * 1000) / 1000 }))

  const entries: DiffEntry[] = []
  removed.forEach((br, i) => {
    const c = center(br)
    entries.push({
      id: `br-rm-${i}`,
      kind: 'bridge',
      change: '连刀点消失',
      title: `连刀点消失 · ${br.contourId.slice(0, 10)}`,
      detail: `缺口宽 ${br.widthMm.toFixed(2)}mm｜位于 #${br.seqBefore}→#${br.seqAfter} 之间`,
      side: 'a',
      focus: c,
      bounds: padBounds(boundsOf([br.a, br.b]), 4),
    })
  })
  added.forEach((br, i) => {
    const c = center(br)
    entries.push({
      id: `br-add-${i}`,
      kind: 'bridge',
      change: '连刀点新增',
      title: `连刀点新增 · ${br.contourId.slice(0, 10)}`,
      detail: `缺口宽 ${br.widthMm.toFixed(2)}mm｜位于 #${br.seqBefore}→#${br.seqAfter} 之间`,
      side: 'b',
      focus: c,
      bounds: padBounds(boundsOf([br.a, br.b]), 4),
    })
  })
  moved.forEach((m, i) => {
    const c = center(m.to)
    const widthChanged = Math.abs(m.from.widthMm - m.to.widthMm) > 0.05
    entries.push({
      id: `br-mv-${i}`,
      kind: 'bridge',
      change: '连刀点移位',
      title: `连刀点${widthChanged ? '移位/变宽' : '移位'} · 偏移 ${m.distanceMm.toFixed(2)}mm`,
      detail: `缺口宽 ${m.from.widthMm.toFixed(2)}mm → ${m.to.widthMm.toFixed(2)}mm｜#${m.from.seqBefore}→#${m.from.seqAfter}`,
      side: 'b',
      focus: c,
      bounds: padBounds(boundsOf([m.from.a, m.from.b, m.to.a, m.to.b]), 4),
    })
  })
  return { added, removed, moved, entries }
}

/** 无向线段距离（端点对端点之和的最小值） */
function travelDistance(x: VersionTravel, y: VersionTravel): number {
  const direct = dist(x.from, y.from) + dist(x.to, y.to)
  const swapped = dist(x.from, y.to) + dist(x.to, y.from)
  return Math.min(direct, swapped) / 2
}

function diffTravels(a: ToolpathVersion, b: ToolpathVersion): {
  added: VersionTravel[]
  removed: VersionTravel[]
  rerouted: Array<{ from: VersionTravel; to: VersionTravel; moveMm: number }>
  entries: DiffEntry[]
} {
  const pairing = nearestPair(a.travels, b.travels, travelDistance, 2)
  const removed = pairing.onlyA
  const added = pairing.onlyB
  const rerouted = pairing.matched
    .filter((p) => p.d > 0.3)
    .map((p) => ({ from: p.a, to: p.b, moveMm: Math.round(p.d * 1000) / 1000 }))

  const entries: DiffEntry[] = []
  removed.forEach((t, i) => {
    entries.push({
      id: `tv-rm-${i}`,
      kind: 'travel',
      change: '跳刀消失',
      title: `跳刀消失 · #${t.seqAfter} 之前`,
      detail: `${t.lengthMm.toFixed(2)}mm 空移取消`,
      side: 'a',
      focus: midpoint(t.from, t.to),
      bounds: padBounds(boundsOf([t.from, t.to]), 4),
    })
  })
  added.forEach((t, i) => {
    entries.push({
      id: `tv-add-${i}`,
      kind: 'travel',
      change: '跳刀新增',
      title: `跳刀新增 · #${t.seqAfter} 之前`,
      detail: `新增 ${t.lengthMm.toFixed(2)}mm 空移`,
      side: 'b',
      focus: midpoint(t.from, t.to),
      bounds: padBounds(boundsOf([t.from, t.to]), 4),
    })
  })
  rerouted.forEach((r, i) => {
    entries.push({
      id: `tv-ch-${i}`,
      kind: 'travel',
      change: '跳刀走向变化',
      title: `跳刀走向变化 · #${r.from.seqAfter} → #${r.to.seqAfter}`,
      detail: `端点偏移 ${r.moveMm.toFixed(2)}mm｜长度 ${r.from.lengthMm.toFixed(1)}mm → ${r.to.lengthMm.toFixed(1)}mm`,
      side: 'b',
      focus: midpoint(r.to.from, r.to.to),
      bounds: padBounds(boundsOf([r.from.from, r.from.to, r.to.from, r.to.to]), 4),
    })
  })
  return { added, removed, rerouted, entries }
}

const PARAM_LABELS: Array<{ key: keyof VersionParams; label: string; fmt?: (v: VersionParams[keyof VersionParams]) => string }> = [
  { key: 'bridgeRule', label: '连刀点规则' },
  { key: 'areaThresholdMm2', label: '小碎片阈值', fmt: (v) => `${v} mm²` },
  { key: 'bridgeWidthMm', label: '连刀点宽度', fmt: (v) => `${v} mm` },
  { key: 'bridgeEveryMm', label: '大轮廓间隔', fmt: (v) => `${v} mm` },
  { key: 'travelOptimize', label: '跳刀优化' },
  { key: 'useBladeOffset', label: '刀补偏置' },
  { key: 'materialName', label: '材料预设' },
  { key: 'materialForce', label: '刀压' },
  { key: 'materialSpeedMmS', label: '切割速度', fmt: (v) => `${v} mm/s` },
  { key: 'materialPasses', label: '重复次数' },
  { key: 'materialBladeOffsetMm', label: '刀补量', fmt: (v) => `${v} mm` },
  { key: 'toleranceMm', label: '离散化容差', fmt: (v) => `${v} mm` },
  { key: 'closeToleranceMm', label: '闭合容差', fmt: (v) => `${v} mm` },
  { key: 'exportFormat', label: '导出格式' },
  { key: 'exportScale', label: '导出缩放', fmt: (v) => `${Number(v) * 100}%` },
  { key: 'sheetName', label: '纸幅' },
  { key: 'batchEnabled', label: '批量排版' },
  { key: 'batchRows', label: '排版行 × 列', fmt: () => '' },
]

function fmtParam(params: VersionParams, key: keyof VersionParams): string {
  const def = PARAM_LABELS.find((x) => x.key === key)
  const v = params[key]
  if (key === 'batchRows') return `${params.batchRows} × ${params.batchCols}（间距 ${params.batchGapXMm}/${params.batchGapYMm}mm${params.batchSharedEdge ? '，共边' : ''}）`
  if (key === 'travelOptimize') return v === 'nearest_2opt' ? '最近邻 + 2-opt' : '最近邻'
  if (key === 'bridgeRule') return v === 'by_area' ? '按面积（碎片必连）' : v === 'by_length' ? '按长度' : '仅手工'
  if (key === 'useBladeOffset' || key === 'batchEnabled') return v ? '开' : '关'
  if (def?.fmt) return def.fmt(v)
  return String(v)
}

function diffParams(a: ToolpathVersion, b: ToolpathVersion): VersionDiff['changedParams'] {
  const out: VersionDiff['changedParams'] = []
  for (const key of Object.keys(a.params) as (keyof VersionParams)[]) {
    const va = a.params[key]
    const vb = b.params[key]
    if (va === vb) continue
    const label = PARAM_LABELS.find((x) => x.key === key)?.label ?? key
    out.push({ key, label, a: fmtParam(a.params, key), b: fmtParam(b.params, key) })
  }
  return out
}

/** 比对两版 */
export function diffVersions(a: ToolpathVersion, b: ToolpathVersion): VersionDiff {
  const seg = markSegments(a, b)
  const segEntries = [...groupSegments(seg.onlyA, 'a', -1), ...groupSegments(seg.onlyB, 'b', 1)]
  const br = diffBridges(a, b)
  const tv = diffTravels(a, b)
  const changedParams = diffParams(a, b)
  const entries = [...segEntries, ...br.entries, ...tv.entries]
  entries.sort((x, y) => (x.kind === y.kind ? x.title.localeCompare(y.title) : x.kind.localeCompare(y.kind)))
  return {
    a,
    b,
    marksA: seg.ma,
    marksB: seg.mb,
    onlyASegments: seg.onlyA,
    onlyBSegments: seg.onlyB,
    entries,
    bridgeAdded: br.added,
    bridgeRemoved: br.removed,
    bridgeMoved: br.moved,
    travelAdded: tv.added,
    travelRemoved: tv.removed,
    travelRerouted: tv.rerouted,
    metrics: {
      cutDeltaMm: Math.round((b.stats.cutLengthMm - a.stats.cutLengthMm) * 1000) / 1000,
      travelDeltaMm: Math.round((b.stats.travelMm - a.stats.travelMm) * 1000) / 1000,
      cutTimeDeltaSec: Math.round((b.stats.cutTimeSec - a.stats.cutTimeSec) * 10) / 10,
    },
    changedParams,
    identical:
      seg.onlyA.length === 0 &&
      seg.onlyB.length === 0 &&
      br.added.length === 0 &&
      br.removed.length === 0 &&
      br.moved.length === 0 &&
      tv.added.length === 0 &&
      tv.removed.length === 0 &&
      tv.rerouted.length === 0,
  }
}

// ---------------- 差异报告导出 ----------------

function fmtTime(sec: number): string {
  if (sec <= 0) return '0 s'
  if (sec < 60) return `${sec.toFixed(1)} s`
  const m = Math.floor(sec / 60)
  const s = Math.round(sec - m * 60)
  return `${m} 分 ${s2(s)} 秒`
}
function s2(n: number): string {
  return String(n).padStart(2, '0')
}
function fmtDate(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${s2(d.getMonth() + 1)}-${s2(d.getDate())} ${s2(d.getHours())}:${s2(d.getMinutes())}`
}
function signed(v: number, digits = 1, unit = ''): string {
  const n = v.toFixed(digits)
  return `${v > 0 ? '+' : ''}${n}${unit}`
}

/** 差异清单导出为 UTF-8 文本（.txt，纯本地生成） */
export function buildDiffReport(diff: VersionDiff): string {
  const { a, b } = diff
  const lines: string[] = []
  lines.push('剪纸刻绘 · 刀路版本对照报告')
  lines.push('==============================')
  lines.push(`项目版本 A：${a.label}（${fmtDate(a.createdAt)}）  格式 ${a.exportFormat.toUpperCase()}`)
  lines.push(`项目版本 B：${b.label}（${fmtDate(b.createdAt)}）  格式 ${b.exportFormat.toUpperCase()}`)
  if (a.note) lines.push(`A 备注：${a.note}`)
  if (b.note) lines.push(`B 备注：${b.note}`)
  lines.push('')
  lines.push('一、三项总差值（B − A）')
  lines.push('------------------------------')
  const m = diff.metrics
  lines.push(`刀路总长：${a.stats.cutLengthMm.toFixed(1)}mm → ${b.stats.cutLengthMm.toFixed(1)}mm（${signed(m.cutDeltaMm, 1, 'mm')}）`)
  lines.push(`跳刀总长：${a.stats.travelMm.toFixed(1)}mm → ${b.stats.travelMm.toFixed(1)}mm（${signed(m.travelDeltaMm, 1, 'mm')}）`)
  lines.push(`预计切割时间：${fmtTime(a.stats.cutTimeSec)} → ${fmtTime(b.stats.cutTimeSec)}（${signed(m.cutTimeDeltaSec, 1, ' s')}）`)
  lines.push(
    `切割段数：${a.stats.runCount} → ${b.stats.runCount}｜连刀点：${a.stats.bridgeCount} → ${b.stats.bridgeCount}｜跳刀次数：${a.travels.length} → ${b.travels.length}`,
  )
  lines.push('')
  lines.push(`二、差异清单（共 ${diff.entries.length} 条）`)
  lines.push('------------------------------')
  if (diff.entries.length === 0) {
    lines.push('两版刀路几何、连刀点与跳刀走向完全一致。')
  } else {
    const groups: Array<[DiffKind, string]> = [
      ['seg_only_a', '只在 A 版出现的切割段'],
      ['seg_only_b', '只在 B 版出现的切割段'],
      ['bridge', '连刀点变化'],
      ['travel', '跳刀变化'],
    ]
    let idx = 1
    for (const [kind, heading] of groups) {
      const items = diff.entries.filter((e) => e.kind === kind)
      if (items.length === 0) continue
      lines.push(`【${heading}】${items.length} 条`)
      for (const e of items) {
        lines.push(`${idx++}. [${e.change}] ${e.title}`)
        lines.push(`   ${e.detail}`)
        lines.push(`   定位：x=${e.focus.x.toFixed(2)}mm y=${e.focus.y.toFixed(2)}mm`)
      }
      lines.push('')
    }
  }
  if (diff.changedParams.length > 0) {
    lines.push('三、切割参数变化')
    lines.push('------------------------------')
    for (const c of diff.changedParams) lines.push(`· ${c.label}：${c.a}  →  ${c.b}`)
  }
  lines.push('')
  lines.push(`生成时间：${fmtDate(Date.now())}｜Paper-cut Plotter Studio`)
  return lines.join('\n')
}

export function downloadDiffReport(projectName: string, diff: VersionDiff): void {
  const text = buildDiffReport(diff)
  const name = `${sanitizeFilename(projectName)}_刀路对照_${diff.a.id.slice(-4)}_vs_${diff.b.id.slice(-4)}.txt`
  downloadText(name, text, 'text/plain;charset=utf-8')
}

// ---------------- 版本库（按项目持久化） ----------------

const LS_KEY = 'papercut-plotter-studio/toolpath-versions/v1'
export const DEFAULT_KEEP = 20

type VersionStore = {
  /** projectId -> versions（新的在前） */
  projects: Record<string, ToolpathVersion[]>
  /** projectId -> { a, b, keep } */
  selection: Record<string, { a: string | null; b: string | null; keep: number }>
  /** 最近做过的对照（裁剪前提示影响面） */
  comparisons: Array<{ projectId: string; a: string; b: string; at: number }>
}

export const versionState = reactive<{ data: VersionStore; ready: boolean; lastError: string | null }>({
  data: { projects: {}, selection: {}, comparisons: [] },
  ready: false,
  lastError: null,
})

function canUseStorage(): boolean {
  try {
    return typeof localStorage !== 'undefined'
  } catch {
    return false
  }
}

export function loadVersionStore(): void {
  if (!canUseStorage()) {
    versionState.ready = true
    return
  }
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as VersionStore
      if (parsed && parsed.projects) {
        versionState.data.projects = parsed.projects
        versionState.data.selection = parsed.selection ?? {}
        versionState.data.comparisons = Array.isArray(parsed.comparisons) ? parsed.comparisons : []
      }
    }
  } catch (e) {
    versionState.lastError = `版本库读取失败：${(e as Error).message}`
  }
  versionState.ready = true
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
function persist(): void {
  if (!canUseStorage()) return
  try {
    const g = globalThis as { localStorage?: Storage }
    if (!g.localStorage) return
    g.localStorage.setItem(LS_KEY, JSON.stringify(versionState.data))
    versionState.lastError = null
  } catch (e) {
    // 大概率是配额超限：保留内存状态，明确提示
    versionState.lastError = `版本库保存失败（本地存储空间不足）：${(e as Error).message}。可在版本管理里减少留存份数后重试。`
  }
}
function schedulePersist(): void {
  if (saveTimer !== null) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    persist()
  }, 200)
}
function persistNow(): void {
  if (saveTimer !== null) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  persist()
}

export function listVersions(projectId: string): ToolpathVersion[] {
  return versionState.data.projects[projectId] ?? []
}

export function getVersion(projectId: string, versionId: string): ToolpathVersion | null {
  return listVersions(projectId).find((v) => v.id === versionId) ?? null
}

export function getSelection(projectId: string): { a: string | null; b: string | null; keep: number } {
  return versionState.data.selection[projectId] ?? { a: null, b: null, keep: DEFAULT_KEEP }
}

export function setSelection(projectId: string, patch: Partial<{ a: string | null; b: string | null; keep: number }>): void {
  const cur = getSelection(projectId)
  versionState.data.selection[projectId] = { ...cur, ...patch }
  schedulePersist()
}

/**
 * 存档一版。刀路 + 参数与最新一版完全相同时不重复入库（返回 duplicated=true 的最新版）。
 */
export function saveVersion(projectId: string, inp: SnapshotInputs): VersionSaveOutcome {
  try {
    const list = listVersions(projectId)
    const seqOfDay = list.length + 1
    const v = buildVersion(inp, seqOfDay)
    if (!v) return { status: 'empty' }
    const latest = list[0]
    if (latest && latest.signature === v.signature) {
      return { status: 'saved', version: latest, duplicated: true }
    }
    const arr = versionState.data.projects[projectId] ?? []
    arr.unshift(v)
    versionState.data.projects[projectId] = arr
    // 默认比对最新两版（仅在用户还没自选过时自动设置，之后不再抢选择）
    const sel = getSelection(projectId)
    if (!sel.a && !sel.b && arr.length >= 2) {
      setSelection(projectId, { b: arr[0].id, a: arr[1].id })
    } else if (!sel.b && arr.length === 1) {
      setSelection(projectId, { b: v.id })
    }
    persistNow()
    return { status: 'saved', version: v, duplicated: false }
  } catch (e) {
    return { status: 'error', message: (e as Error).message }
  }
}

export function updateVersionNote(projectId: string, versionId: string, note: string): void {
  const v = getVersion(projectId, versionId)
  if (v) {
    v.note = note
    schedulePersist()
  }
}

/** 正在用于比对的版本 */
export function protectedIds(projectId: string): Set<string> {
  const sel = getSelection(projectId)
  const ids = new Set<string>()
  if (sel.a) ids.add(sel.a)
  if (sel.b) ids.add(sel.b)
  return ids
}

export function deleteVersion(projectId: string, versionId: string): boolean {
  const ids = protectedIds(projectId)
  if (ids.has(versionId)) return false
  const arr = listVersions(projectId)
  const i = arr.findIndex((v) => v.id === versionId)
  if (i < 0) return false
  arr.splice(i, 1)
  pruneComparisonRefs(projectId)
  schedulePersist()
  return true
}

function pruneComparisonRefs(projectId: string): void {
  const alive = new Set(listVersions(projectId).map((v) => v.id))
  const comps = versionState.data.comparisons
  for (let i = comps.length - 1; i >= 0; i--) {
    const c = comps[i]
    if (c.projectId !== projectId) continue
    if (!alive.has(c.a) || !alive.has(c.b)) comps.splice(i, 1)
  }
  if (comps.length > 60) comps.splice(0, comps.length - 60)
}

export function recordComparison(projectId: string, aId: string, bId: string): void {
  const comps = versionState.data.comparisons
  comps.unshift({ projectId, a: aId, b: bId, at: Date.now() })
  if (comps.length > 60) comps.length = 60
  schedulePersist()
}

export type PrunePreview = {
  candidates: ToolpathVersion[]
  /** 这些候选一旦删除会影响到的历史对照 */
  affectedComparisons: Array<{ a: ToolpathVersion; b: ToolpathVersion; at: number }>
  protected: ToolpathVersion[]
}

/** 预览「只留最近 keep 版」的影响（不动数据） */
export function previewPrune(projectId: string, keep: number): PrunePreview {
  const arr = listVersions(projectId)
  const protectedNow = protectedIds(projectId)
  // 受保护的（正在比对）不参与裁剪；其余按时间从新到旧
  const deletable = arr.filter((v) => !protectedNow.has(v.id))
  const stay = new Set(deletable.slice(0, Math.max(1, keep)).map((v) => v.id))
  const candidates = deletable.filter((v) => !stay.has(v.id))
  const prot = arr.filter((v) => protectedNow.has(v.id))
  const byId = new Map(arr.map((v) => [v.id, v]))
  const affected: PrunePreview['affectedComparisons'] = []
  const candIds = new Set(candidates.map((v) => v.id))
  for (const c of versionState.data.comparisons) {
    if (c.projectId !== projectId) continue
    if (candIds.has(c.a) || candIds.has(c.b)) {
      const va = byId.get(c.a)
      const vb = byId.get(c.b)
      if (va && vb) affected.push({ a: va, b: vb, at: c.at })
    }
  }
  return { candidates, affectedComparisons: affected, protected: prot }
}

/** 执行裁剪：只留最近 keep 版（正在比对的版本始终保留） */
export function pruneVersions(projectId: string, keep: number): ToolpathVersion[] {
  const preview = previewPrune(projectId, keep)
  const drop = new Set(preview.candidates.map((v) => v.id))
  const arr = listVersions(projectId)
  const removed = arr.filter((v) => drop.has(v.id))
  versionState.data.projects[projectId] = arr.filter((v) => !drop.has(v.id))
  const sel = getSelection(projectId)
  versionState.data.selection[projectId] = { ...sel, keep }
  pruneComparisonRefs(projectId)
  persistNow()
  return removed
}

/** 项目被删除时顺带清理 */
export function dropProjectVersions(projectId: string): void {
  delete versionState.data.projects[projectId]
  delete versionState.data.selection[projectId]
  versionState.data.comparisons = versionState.data.comparisons.filter((c) => c.projectId !== projectId)
  schedulePersist()
}
