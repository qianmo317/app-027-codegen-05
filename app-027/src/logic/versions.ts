import { reactive } from 'vue'
import type { BatchCfg, CutSettings, ExportCfg, MaterialPreset, Pt, Project, Sheet, Shape } from './types'
import type { Job, JobStep } from './job'
import type { ComputedShape } from './pipeline'
import { dist, uid } from './geometry'
import { downloadText, sanitizeFilename } from './download'

// ---------------- 数据模型 ----------------

export type VersionStep = {
  seq: number
  shapeId: string
  shapeName: string
  shapeLayer: number
  contourId: string
  runIndex: number
  points: Pt[]
  closed: boolean
  lengthMm: number
  travelFromPrevMm: number
}

export type VersionBridge = {
  shapeId: string
  contourId: string
  at: Pt
  end: Pt
  mid: Pt
  widthMm: number
}

export type VersionMaterial = {
  id: string
  name: string
  speedMmS: number
  passes: number
  force: number
}

export type VersionStats = {
  cutLengthMm: number
  travelMm: number
  runCount: number
  bridgeCount: number
  estimatedSeconds: number
  shapeCount: number
  layerCount: number
}

/** 一版刀路快照：整场（多形状 / 多图层 / 批量排版）一起存 */
export type ToolpathVersion = {
  id: string
  projectId: string
  projectName: string
  /** 序号（本项目内自增） */
  no: number
  label: string
  createdAt: number
  note: string
  settings: CutSettings
  export: ExportCfg
  sheet: Sheet
  batch: BatchCfg | null
  material: VersionMaterial
  steps: VersionStep[]
  bridges: VersionBridge[]
  stats: VersionStats
  /** 刀路几何指纹：几何完全相同的重复导出不重复占版本 */
  geometryKey: string
  /** 参数指纹 */
  settingsKey: string
  sourceFormat: string
}

export type ComparisonRecord = {
  id: string
  aId: string
  bId: string
  createdAt: string
}

type VersionStore = {
  version: number
  projects: Record<string, ToolpathVersion[]>
  comparisons: Record<string, ComparisonRecord[]>
  lastError: string | null
}

const LS_KEY = 'papercut-plotter-studio/versions/v1'

export const versionState = reactive<VersionStore>({
  version: 1,
  projects: {},
  comparisons: {},
  lastError: null,
})

let loaded = false

export function loadVersions(): void {
  if (loaded) return
  loaded = true
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<VersionStore>
      if (parsed.projects && typeof parsed.projects === 'object') versionState.projects = parsed.projects
      if (parsed.comparisons && typeof parsed.comparisons === 'object') versionState.comparisons = parsed.comparisons
    }
  } catch (e) {
    versionState.lastError = `版本库读取失败：${(e as Error).message}`
  }
}

let saveTimer: number | null = null
export function saveVersions(): void {
  if (saveTimer !== null) return
  saveTimer = window.setTimeout(() => {
    saveTimer = null
    try {
      localStorage.setItem(
        LS_KEY,
        JSON.stringify({ version: 1, projects: versionState.projects, comparisons: versionState.comparisons }),
      )
      versionState.lastError = null
    } catch (e) {
      versionState.lastError = `版本库保存失败（本地存储空间可能已满）：${(e as Error).message}`
    }
  }, 200)
}

// ---------------- 快照采集 ----------------

/**
 * 预计切割时间（秒）：
 * 切割时长（按重复次数）+ 跳刀空移（速度取切割速度 2 倍，至少 100mm/s）+ 每段落刀 1.2s。
 */
export function estimateCutSeconds(
  cutLengthMm: number,
  travelMm: number,
  runCount: number,
  material: Pick<MaterialPreset, 'speedMmS' | 'passes'>,
): number {
  const cut = (cutLengthMm * Math.max(1, material.passes)) / Math.max(1, material.speedMmS)
  const travelSpeed = Math.max(100, material.speedMmS * 2)
  const travel = travelMm / travelSpeed
  const pierce = runCount * Math.max(1, material.passes) * 1.2
  return cut + travel + pierce
}

function quant(v: number, step: number): number {
  return Math.round(v / step) * step
}

function hashPoints(acc: { h: number }, p: Pt, step: number): void {
  acc.h = (acc.h * 31 + Math.round(p.x / step) * 7 + Math.round(p.y / step) * 13) % 1_000_000_007
}

function buildGeometryKey(steps: VersionStep[]): string {
  const acc = { h: 17 }
  for (const st of steps) {
    for (const p of st.points) hashPoints(acc, p, 0.01)
    acc.h = (acc.h + (st.closed ? 1 : 0)) % 1_000_000_007
  }
  return `${steps.length}:${acc.h}`
}

function buildSettingsKey(project: Project, material: MaterialPreset, batch: BatchCfg | null): string {
  return JSON.stringify({
    s: project.settings,
    e: project.export,
    sh: { w: project.sheet.widthMm, h: project.sheet.heightMm },
    b: batch,
    m: { id: material.id, sp: material.speedMmS, pa: material.passes, fo: material.force, bo: material.bladeOffsetMm },
  })
}

export type JobDataLike = {
  job: Job
  shape: Shape | null
  isBatch: boolean
  computed: Map<string, ComputedShape>
}

/** 从当前整场任务采集一版快照（不修改项目数据） */
export function captureVersion(
  project: Project,
  jobData: JobDataLike,
  material: MaterialPreset,
  sourceFormat: string,
  now = Date.now(),
): ToolpathVersion {
  const { job, computed } = jobData
  const steps: VersionStep[] = job.steps.map((st: JobStep) => ({
    seq: st.seq,
    shapeId: st.shapeId,
    shapeName: st.shapeName,
    shapeLayer: st.shapeLayer,
    contourId: st.contourId,
    runIndex: st.runIndex,
    points: st.points.map((p) => ({ x: quant(p.x, 0.001), y: quant(p.y, 0.001) })),
    closed: st.closed,
    lengthMm: st.lengthMm,
    travelFromPrevMm: st.travelFromPrevMm,
  }))

  const bridges: VersionBridge[] = []
  for (const [shapeId, comp] of computed.entries()) {
    for (const [contourId, entry] of comp.byId.entries()) {
      for (const a of entry.anchors) {
        bridges.push({
          shapeId,
          contourId,
          at: { x: quant(a.at.x, 0.001), y: quant(a.at.y, 0.001) },
          end: { x: quant(a.end.x, 0.001), y: quant(a.end.y, 0.001) },
          mid: { x: quant((a.at.x + a.end.x) / 2, 0.001), y: quant((a.at.y + a.end.y) / 2, 0.001) },
          widthMm: a.widthMm,
        })
      }
    }
  }

  const shapeIds = new Set(steps.map((s) => s.shapeId))
  const layers = new Set(steps.map((s) => s.shapeLayer))
  const batch = project.batch && project.batch.enabled ? { ...project.batch } : null

  const v: ToolpathVersion = {
    id: uid('tv'),
    projectId: project.id,
    projectName: project.name,
    no: 0,
    label: '',
    createdAt: now,
    note: '',
    settings: JSON.parse(JSON.stringify(project.settings)) as CutSettings,
    export: { ...project.export },
    sheet: { ...project.sheet },
    batch,
    material: {
      id: material.id,
      name: material.name,
      speedMmS: material.speedMmS,
      passes: material.passes,
      force: material.force,
    },
    steps,
    bridges,
    stats: {
      cutLengthMm: job.cutLengthMm,
      travelMm: job.travelMm,
      runCount: job.runCount,
      bridgeCount: bridges.length,
      estimatedSeconds: estimateCutSeconds(job.cutLengthMm, job.travelMm, job.runCount, material),
      shapeCount: shapeIds.size,
      layerCount: layers.size,
    },
    geometryKey: buildGeometryKey(steps),
    settingsKey: buildSettingsKey(project, material, batch),
    sourceFormat,
  }
  return v
}

export type SaveResult = { version: ToolpathVersion; reused: boolean }

/**
 * 存一版：几何 + 参数完全相同的版本已存在时只刷新时间（不重复攒版本）。
 */
export function saveVersion(projectId: string, v: ToolpathVersion): SaveResult {
  loadVersions()
  const list = versionState.projects[projectId] ?? (versionState.projects[projectId] = [])
  const dup = list.find((x) => x.geometryKey === v.geometryKey && x.settingsKey === v.settingsKey)
  if (dup) {
    dup.createdAt = v.createdAt
    dup.sourceFormat = v.sourceFormat
    saveVersions()
    return { version: dup, reused: true }
  }
  const no = (list.reduce((m, x) => Math.max(m, x.no), 0) || 0) + 1
  v.no = no
  v.label = `v${no} · ${formatShortTime(v.createdAt)}`
  list.unshift(v)
  saveVersions()
  return { version: v, reused: false }
}

export function listVersions(projectId: string): ToolpathVersion[] {
  loadVersions()
  return versionState.projects[projectId] ?? []
}

export function getVersion(projectId: string, id: string): ToolpathVersion | null {
  return listVersions(projectId).find((v) => v.id === id) ?? null
}

export function renameVersion(projectId: string, id: string, label: string): void {
  const v = getVersion(projectId, id)
  if (v) {
    v.label = label.slice(0, 40) || v.label
    saveVersions()
  }
}

// ---------------- 对照记录 ----------------

export function comparisonsOf(projectId: string): ComparisonRecord[] {
  loadVersions()
  return versionState.comparisons[projectId] ?? []
}

export function saveComparison(projectId: string, aId: string, bId: string): ComparisonRecord {
  const list = versionState.comparisons[projectId] ?? (versionState.comparisons[projectId] = [])
  const exist = list.find(
    (c) => (c.aId === aId && c.bId === bId) || (c.aId === bId && c.bId === aId),
  )
  if (exist) return exist
  const rec: ComparisonRecord = { id: uid('cmp'), aId, bId, createdAt: new Date().toISOString() }
  list.unshift(rec)
  saveVersions()
  return rec
}

export function deleteComparison(projectId: string, id: string): void {
  const list = versionState.comparisons[projectId]
  if (!list) return
  const i = list.findIndex((c) => c.id === id)
  if (i >= 0) {
    list.splice(i, 1)
    saveVersions()
  }
}

/** 引用了某版本的对照记录 */
export function comparisonsReferencing(projectId: string, versionId: string): ComparisonRecord[] {
  return comparisonsOf(projectId).filter((c) => c.aId === versionId || c.bId === versionId)
}

export class VersionInUseError extends Error {
  comparisons: ComparisonRecord[]
  constructor(comparisons: ComparisonRecord[]) {
    super('该版本正在用于比对，不能删除')
    this.comparisons = comparisons
  }
}

/** 正在用于比对（已保存的对照记录引用中）的版本不许删 */
export function deleteVersion(projectId: string, id: string, activePair: [string, string] | null = null): void {
  const refs = comparisonsReferencing(projectId, id)
  if (activePair && (activePair[0] === id || activePair[1] === id)) {
    throw new VersionInUseError(refs)
  }
  if (refs.length > 0) throw new VersionInUseError(refs)
  const list = versionState.projects[projectId]
  if (!list) return
  const i = list.findIndex((v) => v.id === id)
  if (i >= 0) {
    list.splice(i, 1)
    saveVersions()
  }
}

// ---------------- 只留最近 N 版 ----------------

export type PrunePlan = {
  keep: number
  toDelete: ToolpathVersion[]
  /** 因对照引用而必须保留的旧版（说明会影响哪几次对照） */
  protectedItems: Array<{ version: ToolpathVersion; comparisons: ComparisonRecord[] }>
  /** 整理后剩余版本数 */
  remainCount: number
}

/** 删旧版之前先说明：哪些会删、哪些因被对照引用而保留、各影响哪几次对照 */
export function planPrune(projectId: string, keep: number, activePair: [string, string] | null = null): PrunePlan {
  const list = listVersions(projectId).slice().sort((a, b) => b.createdAt - a.createdAt)
  const n = Number.isFinite(keep) ? Math.max(1, Math.floor(keep)) : 1
  const candidates = list.slice(n)
  const toDelete: ToolpathVersion[] = []
  const protectedItems: PrunePlan['protectedItems'] = []
  for (const v of candidates) {
    const refs = comparisonsReferencing(projectId, v.id)
    const inActive = !!activePair && (activePair[0] === v.id || activePair[1] === v.id)
    if (refs.length > 0 || inActive) protectedItems.push({ version: v, comparisons: refs })
    else toDelete.push(v)
  }
  return { keep: n, toDelete, protectedItems, remainCount: list.length - toDelete.length }
}

export function executePrune(projectId: string, plan: PrunePlan): void {
  const list = versionState.projects[projectId]
  if (!list) return
  const kill = new Set(plan.toDelete.map((v) => v.id))
  const before = list.length
  versionState.projects[projectId] = list.filter((v) => !kill.has(v.id))
  if (before !== versionState.projects[projectId].length) saveVersions()
}

// ---------------- 差异引擎 ----------------

export type DiffRowType =
  | 'cut_only_a'
  | 'cut_only_b'
  | 'bridge_only_a'
  | 'bridge_only_b'
  | 'bridge_moved'
  | 'bridge_width'
  | 'travel_changed'

export type TravelSide = { from: Pt; to: Pt; lengthMm: number }

export type DiffRow = {
  key: string
  type: DiffRowType
  title: string
  detail: string
  /** 点击后图上跳转的位置（mm 原始坐标） */
  where: Pt
  /** 该行聚合的条数 */
  count: number
  /** 图上着色用几何 */
  chainsA?: Pt[][]
  chainsB?: Pt[][]
  bridgeA?: VersionBridge
  bridgeB?: VersionBridge
  travelA?: TravelSide
  travelB?: TravelSide
}

export type ParamChange = { group: string; label: string; a: string; b: string }

export type VersionDiff = {
  a: ToolpathVersion
  b: ToolpathVersion
  rows: DiffRow[]
  rowsByType: Record<DiffRowType, number>
  totals: {
    cutA: number
    cutB: number
    dCut: number
    travelA: number
    travelB: number
    dTravel: number
    secA: number
    secB: number
    dSec: number
    bridgesA: number
    bridgesB: number
    runsA: number
    runsB: number
  }
  paramChanges: ParamChange[]
}

const EDGE_TOL = 0.05
const BRIDGE_MATCH_MM = 1.0
const BRIDGE_MOVED_MM = 0.1
const TRAVEL_PAIR_MM = 0.5
const TRAVEL_TURN_MM = 0.5
const MAX_CUT_ROWS = 150
const MAX_TRAVEL_ROWS = 120

type Edge = { ka: string; kb: string; len: number }

function nodeKey(p: Pt): string {
  return `${Math.round(p.x / EDGE_TOL)},${Math.round(p.y / EDGE_TOL)}`
}

function edgeKey(p1: Pt, p2: Pt): string {
  const k1 = nodeKey(p1)
  const k2 = nodeKey(p2)
  return k1 < k2 ? `${k1}|${k2}` : `${k2}|${k1}`
}

type EdgeInfo = { a: Pt; b: Pt; len: number }

function collectEdges(steps: VersionStep[]): Map<string, { count: number; info: EdgeInfo }> {
  const map = new Map<string, { count: number; info: EdgeInfo }>()
  for (const st of steps) {
    const pts = st.points
    const segCount = st.closed ? pts.length : pts.length - 1
    for (let i = 0; i < segCount; i++) {
      const p1 = pts[i]
      const p2 = pts[(i + 1) % pts.length]
      const len = dist(p1, p2)
      if (len < 1e-6) continue
      const k = edgeKey(p1, p2)
      const e = map.get(k)
      if (e) e.count += 1
      else map.set(k, { count: 1, info: { a: p1, b: p2, len } })
    }
  }
  return map
}

/** 把零散基本段按端点连成折线（方便图上着色与清单聚合） */
function chainEdges(edges: Edge[]): Pt[][] {
  if (edges.length === 0) return []
  const adj = new Map<string, Edge[]>()
  for (const e of edges) {
    const push = (k: string) => {
      const arr = adj.get(k) ?? []
      arr.push(e)
      adj.set(k, arr)
    }
    push(e.ka)
    push(e.kb)
  }

  const chains: Pt[][] = []
  const consumed = new Set<Edge>()
  const nodePt = (k: string): Pt => {
    const [x, y] = k.split(',')
    return { x: Number(x) * EDGE_TOL, y: Number(y) * EDGE_TOL }
  }

  const walk = (startNode: string): Pt[] => {
    const poly: Pt[] = [nodePt(startNode)]
    let cur = startNode
    const usedHere = new Set<Edge>()
    for (;;) {
      const cand = (adj.get(cur) ?? []).find((e) => !consumed.has(e))
      if (!cand) break
      consumed.add(cand)
      usedHere.add(cand)
      cur = cand.ka === cur ? cand.kb : cand.ka
      poly.push(nodePt(cur))
      if (cur === startNode) break
      if (poly.length > edges.length + 2) break
    }
    return poly
  }

  // 先从奇度节点起笔（开放链）
  const oddNodes = [...adj.entries()].filter(([, es]) => es.filter((e) => !consumed.has(e)).length % 2 === 1).map(([k]) => k)
  for (const n of oddNodes) {
    const remain = (adj.get(n) ?? []).some((e) => !consumed.has(e))
    if (remain) chains.push(walk(n))
  }
  // 剩余的成环
  for (const [n, es] of adj.entries()) {
    while (es.some((e) => !consumed.has(e))) chains.push(walk(n))
  }
  return chains.filter((c) => c.length >= 2)
}

function polylineInfo(poly: Pt[]): { len: number; mid: Pt; segCount: number } {
  let len = 0
  const segLens: number[] = []
  for (let i = 0; i + 1 < poly.length; i++) {
    const d = dist(poly[i], poly[i + 1])
    len += d
    segLens.push(d)
  }
  let acc = 0
  const half = len / 2
  let mid = poly[0]
  for (let i = 0; i < segLens.length; i++) {
    if (acc + segLens[i] >= half) {
      const t = segLens[i] > 1e-9 ? (half - acc) / segLens[i] : 0
      mid = {
        x: poly[i].x + (poly[i + 1].x - poly[i].x) * t,
        y: poly[i].y + (poly[i + 1].y - poly[i].y) * t,
      }
      break
    }
    acc += segLens[i]
  }
  const closed = poly.length > 2 && dist(poly[0], poly[poly.length - 1]) < EDGE_TOL / 2
  return { len, mid, segCount: closed ? poly.length : poly.length - 1 }
}

function diffCutSegments(a: ToolpathVersion, b: ToolpathVersion, rows: DiffRow[]): void {
  const ea = collectEdges(a.steps)
  const eb = collectEdges(b.steps)
  const onlyEdges = (
    self: Map<string, { count: number; info: EdgeInfo }>,
    other: Map<string, { count: number; info: EdgeInfo }>,
  ): Edge[] => {
    const out: Edge[] = []
    for (const [k, v] of self.entries()) {
      const extra = v.count - (other.get(k)?.count ?? 0)
      for (let i = 0; i < extra; i++) {
        out.push({ ka: k.split('|')[0], kb: k.split('|')[1], len: v.info.len })
      }
    }
    return out
  }

  const build = (edgesList: Edge[], type: DiffRowType, owner: ToolpathVersion, onlyIn: 'a' | 'b'): void => {
    const chains = chainEdges(edgesList)
    const tag = onlyIn === 'a' ? '旧版独有' : '新版独有'
    const contourNameFor = (poly: Pt[]): string => {
      const names = new Map<string, number>()
      for (const st of owner.steps) {
        if (st.points.some((p) => dist(p, poly[0]) < EDGE_TOL || dist(p, poly[poly.length - 1]) < EDGE_TOL)) {
          names.set(st.shapeName, (names.get(st.shapeName) ?? 0) + 1)
        }
      }
      let best = '未知形状'
      let bestN = 0
      for (const [n, c] of names) {
        if (c > bestN) {
          best = n
          bestN = c
        }
      }
      return best
    }
    let shown = 0
    let overflowSegs = 0
    let overflowLen = 0
    const overflowWhere: Pt[] = []
    for (const poly of chains) {
      const info = polylineInfo(poly)
      if (shown < MAX_CUT_ROWS) {
        rows.push({
          key: `${type}-${shown}`,
          type,
          title: `${tag}切割段 · ${info.segCount} 段连切 · ${info.len.toFixed(1)}mm`,
          detail: contourNameFor(poly),
          where: info.mid,
          count: info.segCount,
          chainsA: onlyIn === 'a' ? [poly] : undefined,
          chainsB: onlyIn === 'b' ? [poly] : undefined,
        })
        shown += 1
      } else {
        overflowSegs += info.segCount
        overflowLen += info.len
        overflowWhere.push(info.mid)
      }
    }
    if (overflowSegs > 0) {
      rows.push({
        key: `${type}-overflow`,
        type,
        title: `${tag}切割段（其余 ${overflowSegs} 段，长 ${overflowLen.toFixed(1)}mm）`,
        detail: `差异段过多，清单只逐条列出前 ${MAX_CUT_ROWS} 处；图上已全部着色。`,
        where: overflowWhere[0],
        count: overflowSegs,
      })
    }
  }

  const edgesA = onlyEdges(ea, eb)
  const edgesB = onlyEdges(eb, ea)
  build(edgesA, 'cut_only_a', a, 'a')
  build(edgesB, 'cut_only_b', b, 'b')
}

function bridgeContourName(v: ToolpathVersion, br: VersionBridge): string {
  const st = v.steps.find((s) => s.contourId === br.contourId)
  return st ? `${st.shapeName}` : '未知形状'
}

function diffBridges(a: ToolpathVersion, b: ToolpathVersion, rows: DiffRow[]): void {
  const usedA = new Set<number>()
  const usedB = new Set<number>()
  const pairs: Array<{ i: number; j: number; d: number }> = []
  // 位置以缺口锚定端 at 为准（手工连刀点 at 就是用户点选的顶点）；中点做兜底
  const bridgeDist = (x: VersionBridge, y: VersionBridge): number => {
    const dAt = dist(x.at, y.at)
    const dMid = dist(x.mid, y.mid)
    return Math.min(dAt, dMid)
  }
  a.bridges.forEach((ba, i) => {
    b.bridges.forEach((bb, j) => {
      if (ba.contourId !== bb.contourId) return
      const d = bridgeDist(ba, bb)
      if (d <= BRIDGE_MATCH_MM) pairs.push({ i, j, d })
    })
  })
  // 同轮廓没匹配上再跨轮廓兜底
  a.bridges.forEach((ba, i) => {
    b.bridges.forEach((bb, j) => {
      if (ba.contourId === bb.contourId) return
      const d = bridgeDist(ba, bb)
      if (d <= BRIDGE_MATCH_MM) pairs.push({ i, j, d })
    })
  })
  pairs.sort((p, q) => p.d - q.d)
  for (const p of pairs) {
    if (usedA.has(p.i) || usedB.has(p.j)) continue
    usedA.add(p.i)
    usedB.add(p.j)
    const ba = a.bridges[p.i]
    const bb = b.bridges[p.j]
    const widthDelta = bb.widthMm - ba.widthMm
    if (p.d > BRIDGE_MOVED_MM) {
      rows.push({
        key: `bridge-moved-${p.i}-${p.j}`,
        type: 'bridge_moved',
        title: `连刀点位置变化 · 偏移 ${p.d.toFixed(2)}mm`,
        detail: `${bridgeContourName(a, ba)}｜缺口宽 ${ba.widthMm.toFixed(2)} → ${bb.widthMm.toFixed(2)}mm${
          Math.abs(widthDelta) > 0.01 ? `（${widthDelta > 0 ? '加宽' : '变窄'} ${Math.abs(widthDelta).toFixed(2)}mm）` : ''
        }`,
        where: { x: (ba.mid.x + bb.mid.x) / 2, y: (ba.mid.y + bb.mid.y) / 2 },
        count: 1,
        bridgeA: ba,
        bridgeB: bb,
      })
    } else if (Math.abs(widthDelta) > 0.01) {
      rows.push({
        key: `bridge-width-${p.i}-${p.j}`,
        type: 'bridge_width',
        title: `连刀点宽度变化 · ${ba.widthMm.toFixed(2)} → ${bb.widthMm.toFixed(2)}mm`,
        detail: `${bridgeContourName(a, ba)}｜位置未变（偏差 ${p.d.toFixed(2)}mm）`,
        where: ba.mid,
        count: 1,
        bridgeA: ba,
        bridgeB: bb,
      })
    }
  }

  a.bridges.forEach((ba, i) => {
    if (usedA.has(i)) return
    rows.push({
      key: `bridge-a-${i}`,
      type: 'bridge_only_a',
      title: '连刀点消失（旧版有、新版无）',
      detail: `${bridgeContourName(a, ba)}｜缺口宽 ${ba.widthMm.toFixed(2)}mm`,
      where: ba.mid,
      count: 1,
      bridgeA: ba,
    })
  })
  b.bridges.forEach((bb, j) => {
    if (usedB.has(j)) return
    rows.push({
      key: `bridge-b-${j}`,
      type: 'bridge_only_b',
      title: '连刀点新增（新版有、旧版无）',
      detail: `${bridgeContourName(b, bb)}｜缺口宽 ${bb.widthMm.toFixed(2)}mm`,
      where: bb.mid,
      count: 1,
      bridgeB: bb,
    })
  })
}

type Travel = { seq: number; from: Pt; to: Pt; len: number }

function travelsOf(v: ToolpathVersion): Travel[] {
  const out: Travel[] = []
  for (let i = 1; i < v.steps.length; i++) {
    const prev = v.steps[i - 1]
    const cur = v.steps[i]
    const from = prev.points[prev.points.length - 1]
    const to = cur.points[0]
    if (dist(from, to) < 0.05) continue
    out.push({ seq: cur.seq, from, to, len: cur.travelFromPrevMm || dist(from, to) })
  }
  return out
}

function angleOf(t: Travel): number {
  return Math.atan2(t.to.y - t.from.y, t.to.x - t.from.x)
}

function diffTravels(a: ToolpathVersion, b: ToolpathVersion, rows: DiffRow[]): void {
  const ta = travelsOf(a)
  const tb = travelsOf(b)
  const usedA = new Set<number>()
  const usedB = new Set<number>()

  // 起点接近的跳刀两两配对（贪心，最近优先）
  const pairs: Array<{ i: number; j: number; d: number }> = []
  ta.forEach((x, i) => {
    tb.forEach((y, j) => {
      const d = dist(x.from, y.from)
      if (d <= TRAVEL_PAIR_MM) pairs.push({ i, j, d })
    })
  })
  pairs.sort((p, q) => p.d - q.d)
  for (const p of pairs) {
    if (usedA.has(p.i) || usedB.has(p.j)) continue
    usedA.add(p.i)
    usedB.add(p.j)
  }

  let shown = 0
  let overflow = 0
  const overflowWhere: Pt[] = []
  const midOf = (t: Travel) => ({ x: (t.from.x + t.to.x) / 2, y: (t.from.y + t.to.y) / 2 })
  const pushRow = (r: DiffRow): void => {
    if (shown < MAX_TRAVEL_ROWS) {
      rows.push(r)
      shown += 1
    } else {
      overflow += 1
      overflowWhere.push(r.where)
    }
  }

  // 配对上的：终点不同 = 走向改变
  for (const p of pairs) {
    if (!usedA.has(p.i)) continue
    const x = ta[p.i]
    const y = tb[p.j]
    if (dist(x.to, y.to) <= TRAVEL_TURN_MM) continue
    let da = (angleOf(y) - angleOf(x)) * (180 / Math.PI)
    while (da > 180) da -= 360
    while (da < -180) da += 360
    pushRow({
      key: `travel-${x.seq}-${y.seq}`,
      type: 'travel_changed',
      title: `跳刀走向改变 · 偏转 ${Math.abs(da).toFixed(0)}°`,
      detail: `第 ${y.seq} 段前的跳刀｜长度 ${x.len.toFixed(1)} → ${y.len.toFixed(1)}mm`,
      where: midOf(x),
      count: 1,
      travelA: { from: x.from, to: x.to, lengthMm: x.len },
      travelB: { from: y.from, to: y.to, lengthMm: y.len },
    })
  }
  // 配不上的：只在其中一版出现的跳刀走向
  ta.forEach((x, i) => {
    if (usedA.has(i)) return
    pushRow({
      key: `travel-a-${x.seq}`,
      type: 'travel_changed',
      title: '跳刀走向消失（旧版有、新版无）',
      detail: `第 ${x.seq} 段前的跳刀｜长度 ${x.len.toFixed(1)}mm`,
      where: midOf(x),
      count: 1,
      travelA: { from: x.from, to: x.to, lengthMm: x.len },
    })
  })
  tb.forEach((y, j) => {
    if (usedB.has(j)) return
    pushRow({
      key: `travel-b-${y.seq}`,
      type: 'travel_changed',
      title: '跳刀走向新增（新版有、旧版无）',
      detail: `第 ${y.seq} 段前的跳刀｜长度 ${y.len.toFixed(1)}mm`,
      where: midOf(y),
      count: 1,
      travelB: { from: y.from, to: y.to, lengthMm: y.len },
    })
  })
  if (overflow > 0) {
    rows.push({
      key: 'travel-overflow',
      type: 'travel_changed',
      title: `跳刀走向差异（其余 ${overflow} 处）`,
      detail: `差异过多，清单只逐条列出前 ${MAX_TRAVEL_ROWS} 处；图上已全部着色。`,
      where: overflowWhere[0],
      count: overflow,
    })
  }
}

// ---------------- 参数对照 ----------------

const SETTING_LABELS: Record<string, string> = {
  bridgeRule: '连刀点规则',
  areaThresholdMm2: '碎片面积阈值',
  bridgeWidthMm: '连刀点宽度',
  bridgeEveryMm: '连刀点间距',
  travelOptimize: '跳刀优化',
  toleranceMm: '离散化容差',
  closeToleranceMm: '闭合判定容差',
  useBladeOffset: '刀补偏置',
}

function bridgeRuleText(v: string): string {
  return v === 'by_area' ? '按面积（碎片强制）' : v === 'by_length' ? '按长度等分' : '手工放置'
}
function optimizeText(v: string): string {
  return v === 'nearest_2opt' ? '最近邻 + 2-opt' : '最近邻'
}

function settingValue(key: string, v: unknown): string {
  if (key === 'bridgeRule') return bridgeRuleText(String(v))
  if (key === 'travelOptimize') return optimizeText(String(v))
  if (key === 'useBladeOffset') return v ? '启用' : '关闭'
  if (typeof v === 'number') return String(v)
  return String(v)
}

function diffParams(a: ToolpathVersion, b: ToolpathVersion): ParamChange[] {
  const out: ParamChange[] = []
  for (const key of Object.keys(SETTING_LABELS)) {
    const va = (a.settings as Record<string, unknown>)[key]
    const vb = (b.settings as Record<string, unknown>)[key]
    if (JSON.stringify(va) !== JSON.stringify(vb)) {
      out.push({ group: '切割参数', label: SETTING_LABELS[key], a: settingValue(key, va), b: settingValue(key, vb) })
    }
  }
  const ea = a.export
  const eb = b.export
  const push = (group: string, label: string, x: string, y: string) => {
    if (x !== y) out.push({ group, label, a: x, b: y })
  }
  push('导出设置', '导出格式', ea.format.toUpperCase(), eb.format.toUpperCase())
  push('导出设置', '缩放', `${ea.scale}`, `${eb.scale}`)
  push('导出设置', '坐标单位', ea.unit, eb.unit)
  push('纸幅', '纸幅', `${a.sheet.name} ${a.sheet.widthMm}×${a.sheet.heightMm}mm`, `${b.sheet.name} ${b.sheet.widthMm}×${b.sheet.heightMm}mm`)
  const ba = a.batch
  const bb = b.batch
  push(
    '批量排版',
    '排版',
    ba && ba.enabled ? `${ba.cols}×${ba.rows}，间距 ${ba.gapXMm}/${ba.gapYMm}mm${ba.sharedEdge ? '，共边' : ''}` : '关闭',
    bb && bb.enabled ? `${bb.cols}×${bb.rows}，间距 ${bb.gapXMm}/${bb.gapYMm}mm${bb.sharedEdge ? '，共边' : ''}` : '关闭',
  )
  push('材料', '材料', `${a.material.name}（${a.material.speedMmS}mm/s × ${a.material.passes} 次，刀压 ${a.material.force}）`, `${b.material.name}（${b.material.speedMmS}mm/s × ${b.material.passes} 次，刀压 ${b.material.force}）`)
  return out
}

const ROW_ORDER: Record<DiffRowType, number> = {
  cut_only_a: 0,
  cut_only_b: 1,
  bridge_only_a: 2,
  bridge_only_b: 3,
  bridge_moved: 4,
  bridge_width: 5,
  travel_changed: 6,
}

/** 两版比对主入口 */
export function diffVersions(a: ToolpathVersion, b: ToolpathVersion): VersionDiff {
  const rows: DiffRow[] = []
  diffCutSegments(a, b, rows)
  diffBridges(a, b, rows)
  diffTravels(a, b, rows)
  rows.sort((x, y) => ROW_ORDER[x.type] - ROW_ORDER[y.type])

  const rowsByType = {
    cut_only_a: 0,
    cut_only_b: 0,
    bridge_only_a: 0,
    bridge_only_b: 0,
    bridge_moved: 0,
    bridge_width: 0,
    travel_changed: 0,
  } as Record<DiffRowType, number>
  for (const r of rows) rowsByType[r.type] += 1

  return {
    a,
    b,
    rows,
    rowsByType,
    totals: {
      cutA: a.stats.cutLengthMm,
      cutB: b.stats.cutLengthMm,
      dCut: b.stats.cutLengthMm - a.stats.cutLengthMm,
      travelA: a.stats.travelMm,
      travelB: b.stats.travelMm,
      dTravel: b.stats.travelMm - a.stats.travelMm,
      secA: a.stats.estimatedSeconds,
      secB: b.stats.estimatedSeconds,
      dSec: b.stats.estimatedSeconds - a.stats.estimatedSeconds,
      bridgesA: a.stats.bridgeCount,
      bridgesB: b.stats.bridgeCount,
      runsA: a.stats.runCount,
      runsB: b.stats.runCount,
    },
    paramChanges: diffParams(a, b),
  }
}

// ---------------- 格式化 ----------------

export function fmtMm(v: number): string {
  return `${v.toFixed(1)} mm`
}

export function fmtSignedMm(v: number): string {
  const s = v > 0 ? '+' : v < 0 ? '−' : '±'
  return `${s}${Math.abs(v).toFixed(1)} mm`
}

export function fmtSeconds(v: number): string {
  if (v < 60) return `${v.toFixed(0)} 秒`
  const m = Math.floor(v / 60)
  const s = Math.round(v % 60)
  return `${m} 分 ${s.toString().padStart(2, '0')} 秒`
}

export function fmtSignedSeconds(v: number): string {
  const sign = v > 0 ? '+' : v < 0 ? '−' : '±'
  const abs = Math.abs(v)
  if (abs < 60) return `${sign}${abs.toFixed(0)} 秒`
  const m = Math.floor(abs / 60)
  const s = Math.round(abs % 60)
  return `${sign}${m} 分 ${s.toString().padStart(2, '0')} 秒`
}

export function formatFullTime(t: number): string {
  const d = new Date(t)
  const p = (n: number) => n.toString().padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function formatShortTime(t: number): string {
  const d = new Date(t)
  const p = (n: number) => n.toString().padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export const ROW_GROUP_TITLES: Array<{ type: DiffRowType; title: string }> = [
  { type: 'cut_only_a', title: '只在旧版里出现的切割段' },
  { type: 'cut_only_b', title: '只在新版里出现的切割段' },
  { type: 'bridge_only_a', title: '连刀点：旧版有 / 新版无' },
  { type: 'bridge_only_b', title: '连刀点：新版有 / 旧版无' },
  { type: 'bridge_moved', title: '连刀点位置变化' },
  { type: 'bridge_width', title: '连刀点宽度变化（位置未变）' },
  { type: 'travel_changed', title: '跳刀走向变化' },
]

// ---------------- 差异清单导出 ----------------

export function buildDiffReport(diff: VersionDiff): string {
  const { a, b, totals, rows, rowsByType, paramChanges } = diff
  const L: string[] = []
  L.push(`# 刀路版本对照清单`)
  L.push('')
  L.push(`- 项目：${a.projectName}（多形状 / 多图层按整场快照）`)
  L.push(`- 旧版 A：${a.label}（${formatFullTime(a.createdAt)}，来源 ${a.sourceFormat}）`)
  L.push(`- 新版 B：${b.label}（${formatFullTime(b.createdAt)}，来源 ${b.sourceFormat}）`)
  L.push(`- 形状数：${a.stats.shapeCount} → ${b.stats.shapeCount}｜图层数：${a.stats.layerCount} → ${b.stats.layerCount}`)
  L.push(`- 导出时间：${formatFullTime(Date.now())}`)
  L.push('')
  L.push('## 三个总数之差（B − A）')
  L.push('')
  L.push('| 指标 | 旧版 A | 新版 B | 差值 B−A |')
  L.push('| --- | ---: | ---: | ---: |')
  L.push(`| 刀路总长 | ${totals.cutA.toFixed(1)} mm | ${totals.cutB.toFixed(1)} mm | ${fmtSignedMm(totals.dCut)} |`)
  L.push(`| 跳刀总长 | ${totals.travelA.toFixed(1)} mm | ${totals.travelB.toFixed(1)} mm | ${fmtSignedMm(totals.dTravel)} |`)
  L.push(`| 预计切割时间 | ${fmtSeconds(totals.secA)} | ${fmtSeconds(totals.secB)} | ${fmtSignedSeconds(totals.dSec)} |`)
  L.push(`| 切割段数 | ${totals.runsA} | ${totals.runsB} | ${totals.runsB - totals.runsA > 0 ? '+' : ''}${totals.runsB - totals.runsA} |`)
  L.push(`| 连刀点数量 | ${totals.bridgesA} | ${totals.bridgesB} | ${totals.bridgesB - totals.bridgesA > 0 ? '+' : ''}${totals.bridgesB - totals.bridgesA} |`)
  L.push('')

  L.push('## 切割参数 / 连刀点设置差异')
  L.push('')
  if (paramChanges.length === 0) {
    L.push('两版参数完全一致，差异仅来自纹样几何本身。')
  } else {
    L.push('| 分组 | 参数 | 旧版 A | 新版 B |')
    L.push('| --- | --- | --- | --- |')
    for (const c of paramChanges) L.push(`| ${c.group} | ${c.label} | ${c.a} | ${c.b} |`)
  }
  L.push('')

  L.push('## 差异明细')
  L.push('')
  if (rows.length === 0) {
    L.push('两版刀路几何完全一致，没有差异。')
  } else {
    for (const g of ROW_GROUP_TITLES) {
      const groupRows = rows.filter((r) => r.type === g.type)
      if (groupRows.length === 0) continue
      const totalCount = groupRows.reduce((s, r) => s + r.count, 0)
      L.push(`### ${g.title}（${rowsByType[g.type]} 条 / 共 ${totalCount} 段处）`)
      L.push('')
      groupRows.forEach((r, i) => {
        L.push(`${i + 1}. ${r.title}｜${r.detail}｜图上位置 (${r.where.x.toFixed(1)}, ${r.where.y.toFixed(1)})mm`)
      })
      L.push('')
    }
  }
  L.push('> 在应用的「版本对照」页点击任意一条可直接跳到图上对应位置。')
  L.push('')
  return L.join('\n')
}

export function diffReportFilename(diff: VersionDiff): string {
  return sanitizeFilename(`刀路对照_${diff.a.label}_vs_${diff.b.label}.md`)
}

export function downloadDiffReport(diff: VersionDiff): void {
  downloadText(diffReportFilename(diff), buildDiffReport(diff), 'text/markdown;charset=utf-8')
}
