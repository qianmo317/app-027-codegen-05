<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import PreviewCanvas from '@/components/PreviewCanvas.vue'
import type { OverlayBridge, OverlayPath, OverlayTravel } from '@/components/overlay'
import { store } from '@/logic/store'
import type { Pt, Shape, Sheet } from '@/logic/types'
import {
  comparisonsOf,
  deleteComparison,
  deleteVersion,
  diffVersions,
  downloadDiffReport,
  executePrune,
  fmtMm,
  fmtSeconds,
  fmtSignedMm,
  fmtSignedSeconds,
  formatFullTime,
  listVersions,
  planPrune,
  renameVersion,
  saveComparison,
  VersionInUseError,
  ROW_GROUP_TITLES,
  type DiffRow,
  type DiffRowType,
  type ToolpathVersion,
  type TravelSide,
  type VersionDiff,
} from '@/logic/versions'

const route = useRoute()
const router = useRouter()
const canvas = ref<InstanceType<typeof PreviewCanvas> | null>(null)

const projectId = computed(() => String(route.params.id))
const project = computed(() => store.getProject(projectId.value) ?? null)
const versions = ref<ToolpathVersion[]>([])

function refresh(): void {
  versions.value = listVersions(projectId.value)
}
refresh()
watch(projectId, () => {
  refresh()
  aId.value = (route.query.a as string) ?? ''
  bId.value = (route.query.b as string) ?? ''
})

const aId = ref<string>((route.query.a as string) ?? '')
const bId = ref<string>((route.query.b as string) ?? '')

watch([aId, bId], () => {
  router.replace({ query: { a: aId.value || undefined, b: bId.value || undefined } })
})

const versionA = computed(() => versions.value.find((v) => v.id === aId.value) ?? null)
const versionB = computed(() => versions.value.find((v) => v.id === bId.value) ?? null)

const diff = computed<VersionDiff | null>(() => {
  if (!versionA.value || !versionB.value || versionA.value.id === versionB.value.id) return null
  return diffVersions(versionA.value, versionB.value)
})

const activePair = computed<[string, string] | null>(
  () => (versionA.value && versionB.value ? [versionA.value.id, versionB.value.id] : null),
)

// 自动保存本次对照（用于「正在比对的版本不许删」）
watch(diff, (d) => {
  if (d && project.value) saveComparison(project.value.id, d.a.id, d.b.id)
})

const savedComparisons = computed(() => (project.value ? comparisonsOf(project.value.id) : []))

function versionLabel(id: string): string {
  return versions.value.find((v) => v.id === id)?.label ?? '（版本已删除）'
}

function versionTime(id: string): string {
  const t = versions.value.find((v) => v.id === id)?.createdAt
  return t ? formatFullTime(t) : ''
}

function removeComparison(id: string): void {
  if (!project.value) return
  deleteComparison(project.value.id, id)
  refresh()
}

// ---------------- 图上叠加 ----------------

const COLOR_A = '#4ea1ff' // 旧版：蓝
const COLOR_B = '#ff6b6b' // 新版：红
const COLOR_COMMON = '#5c6b7c' // 共有：暗灰
const COLOR_TRAVEL_A = '#4ea1ff'
const COLOR_TRAVEL_B = '#ff6b6b'
const COLOR_HILITE = '#ffe14d' // 选中条目：黄

const sheet = computed<Sheet | null>(() =>
  versionB.value ? { ...versionB.value.sheet } : versionA.value ? { ...versionA.value.sheet } : null,
)

/** 合成形状：只为让画布按整场范围取景 */
const syntheticShapes = computed<Shape[]>(() => {
  if (!versionA.value && !versionB.value) return []
  const mk = (v: ToolpathVersion): Shape => ({
    id: `snap-${v.id}`,
    name: v.label,
    layer: 0,
    contours: v.steps.map((st, i) => ({
      id: `${v.id}-c${i}`,
      points: st.points,
      closed: st.closed,
      area: 0,
      length: st.lengthMm,
      holes: [],
      bridges: [],
      warnings: [],
    })),
  })
  return [...(versionA.value ? [mk(versionA.value)] : []), ...(versionB.value ? [mk(versionB.value)] : [])]
})

/** 把某版的所有切割步骤铺成折线 */
function pathsOfVersion(v: ToolpathVersion, color: string, emphasisKeys: Set<string>): OverlayPath[] {
  return v.steps.map((st, i) => {
    const key = `v-${v.id}-${i}`
    const emp = emphasisKeys.has(key)
    return {
      key,
      points: st.points,
      closed: st.closed,
      color: emp ? COLOR_HILITE : color,
      width: emp ? 2.8 : 1.3,
      opacity: emphasisKeys.size > 0 && !emp ? 0.28 : 0.9,
      emphasis: emp,
    }
  })
}

function travelsOfVersion(v: ToolpathVersion, color: string, emphasisKeys: Set<string>): OverlayTravel[] {
  const out: OverlayTravel[] = []
  for (let i = 1; i < v.steps.length; i++) {
    const from = v.steps[i - 1].points[v.steps[i - 1].points.length - 1]
    const to = v.steps[i].points[0]
    if (Math.hypot(to.x - from.x, to.y - from.y) < 0.05) continue
    const key = `t-${v.id}-${i}`
    const emp = emphasisKeys.has(key)
    out.push({ key, from, to, color: emp ? COLOR_HILITE : color, emphasis: emp, dashed: !emp })
  }
  return out
}

const selectedRowKey = ref<string | null>(null)
const selectedRow = computed<DiffRow | null>(() => diff.value?.rows.find((r) => r.key === selectedRowKey.value) ?? null)

/** 当前条目关联的步骤 / 跳刀 key（用于高亮整段） */
const emphasisStepKeys = computed<Set<string>>(() => {
  const set = new Set<string>()
  const r = selectedRow.value
  const d = diff.value
  if (!r || !d) return set
  const collect = (polys: Pt[][] | undefined, v: ToolpathVersion) => {
    if (!polys) return
    v.steps.forEach((st, i) => {
      for (const poly of polys) {
        if (st.points.some((p) => poly.some((q) => Math.hypot(p.x - q.x, p.y - q.y) < 0.06))) {
          set.add(`v-${v.id}-${i}`)
          break
        }
      }
    })
  }
  collect(r.chainsA, d.a)
  collect(r.chainsB, d.b)
  // 跳刀行：高亮对应走向
  const collectTravel = (side: TravelSide | undefined, v: ToolpathVersion) => {
    if (!side) return
    for (let i = 1; i < v.steps.length; i++) {
      const from = v.steps[i - 1].points[v.steps[i - 1].points.length - 1]
      const to = v.steps[i].points[0]
      if (Math.hypot(from.x - side.from.x, from.y - side.from.y) < 0.6 && Math.hypot(to.x - side.to.x, to.y - side.to.y) < 0.6) {
        set.add(`t-${v.id}-${i}`)
      }
    }
  }
  collectTravel(r.travelA, d.a)
  collectTravel(r.travelB, d.b)
  return set
})

const showCommon = ref(true)
const showTravels = ref(true)
const showBridges = ref(true)

const overlayPaths = computed<OverlayPath[]>(() => {
  const d = diff.value
  if (!d) return []
  const out: OverlayPath[] = []
  if (showCommon.value) {
    out.push(...pathsOfVersion(d.a, COLOR_COMMON, emphasisStepKeys.value))
    out.push(...pathsOfVersion(d.b, COLOR_COMMON, emphasisStepKeys.value))
  } else {
    out.push(...pathsOfVersion(d.a, COLOR_A, emphasisStepKeys.value))
    out.push(...pathsOfVersion(d.b, COLOR_B, emphasisStepKeys.value))
  }
  return out
})

const overlayTravels = computed<OverlayTravel[]>(() => {
  const d = diff.value
  if (!d || !showTravels.value) return []
  return [
    ...travelsOfVersion(d.a, COLOR_TRAVEL_A, emphasisStepKeys.value),
    ...travelsOfVersion(d.b, COLOR_TRAVEL_B, emphasisStepKeys.value),
  ]
})

const overlayBridges = computed<OverlayBridge[]>(() => {
  const d = diff.value
  if (!d || !showBridges.value) return []
  const r = selectedRow.value
  const out: OverlayBridge[] = []
  d.a.bridges.forEach((br, i) => {
    const emp = !!r && ((r.bridgeA === br) || r.type === 'bridge_moved')
    out.push({ key: `ba-${i}`, at: br.at, end: br.end, color: r && !emp ? '#6d7e90' : COLOR_A, emphasis: emp })
  })
  d.b.bridges.forEach((br, i) => {
    const emp = !!r && ((r.bridgeB === br) || r.type === 'bridge_moved')
    out.push({ key: `bb-${i}`, at: br.at, end: br.end, color: r && !emp ? '#6d7e90' : COLOR_B, emphasis: emp })
  })
  return out
})

// ---------------- 点清单跳转 ----------------

const focusMarker = ref<Pt | null>(null)

function jumpTo(row: DiffRow): void {
  selectedRowKey.value = row.key
  focusMarker.value = { ...row.where }
  nextTick(() => canvas.value?.focusPoint(row.where))
}

// ---------------- 删除 / 整理 ----------------

const message = ref<{ kind: 'ok' | 'err'; text: string } | null>(null)
function flash(kind: 'ok' | 'err', text: string): void {
  message.value = { kind, text }
  window.setTimeout(() => {
    if (message.value?.text === text) message.value = null
  }, 4000)
}

const keepN = ref(10)
const prunePlan = computed(() => (project.value ? planPrune(project.value.id, keepN.value, activePair.value) : null))

function onDeleteVersion(v: ToolpathVersion): void {
  if (!project.value) return
  try {
    deleteVersion(project.value.id, v.id, activePair.value)
    if (aId.value === v.id) aId.value = ''
    if (bId.value === v.id) bId.value = ''
    refresh()
    flash('ok', `已删除 ${v.label}`)
  } catch (e) {
    if (e instanceof VersionInUseError) {
      const n = e.comparisons.length
      flash(
        'err',
        `「${v.label}」正在用于比对（${n} 次对照引用），不能删除。先在本页底部「已保存的对照」里删掉相关对照记录（当前选中的两版需先改选），再删除该版本。`,
      )
    } else {
      flash('err', (e as Error).message)
    }
  }
}

function onExecutePrune(): void {
  if (!project.value || !prunePlan.value) return
  const plan = prunePlan.value
  if (plan.toDelete.length === 0) {
    flash('ok', '没有需要删除的旧版')
    return
  }
  const protectedNote =
    plan.protectedItems.length > 0
      ? `；另有 ${plan.protectedItems.length} 个旧版被对照引用而保留（不会影响任何已有对照）`
      : ''
  executePrune(project.value.id, plan)
  // 若选中版本被删（不会发生，受保护），保险处理
  refresh()
  flash('ok', `已保留最近 ${plan.keep} 版，删除 ${plan.toDelete.length} 个旧版${protectedNote}。`)
}

function onRename(v: ToolpathVersion): void {
  const label = window.prompt('给这一版起个名字（参数说明）', v.label)
  if (label !== null && project.value) {
    renameVersion(project.value.id, v.id, label.trim())
    refresh()
  }
}

// ---------------- 分组清单 ----------------

const groupedRows = computed(() => {
  const d = diff.value
  if (!d) return []
  return ROW_GROUP_TITLES.map((g) => ({
    ...g,
    rows: d.rows.filter((r) => r.type === g.type),
  })).filter((g) => g.rows.length > 0)
})

function typeTagClass(t: DiffRowType): string {
  if (t === 'cut_only_a' || t === 'bridge_only_a') return 'tag a'
  if (t === 'cut_only_b' || t === 'bridge_only_b') return 'tag b'
  return 'tag chg'
}

const groupTagClass = (t: DiffRowType): string => typeTagClass(t)

const statusText = computed(() => {
  const d = diff.value
  if (!d) return ''
  return `共 ${d.rows.length} 条差异｜蓝=旧版 ${d.a.label}｜红=新版 ${d.b.label}`
})

function swapSides(): void {
  const t = aId.value
  aId.value = bId.value
  bId.value = t
}

watch(
  () => route.query,
  (q) => {
    if (q.a && typeof q.a === 'string') aId.value = q.a
    if (q.b && typeof q.b === 'string') bId.value = q.b
  },
)
</script>

<template>
  <div v-if="!project" class="splash">项目不存在 <RouterLink to="/">返回纹样库</RouterLink></div>
  <div v-else class="compare-page">
    <!-- 顶部：版本选择 -->
    <div class="panel">
      <div class="panel-head">
        刀路版本对照 · {{ project.name }}
        <span class="spacer"></span>
        <RouterLink class="tiny" :to="`/export/${project.id}`">返回导出页</RouterLink>
      </div>
      <div class="panel-body">
        <div v-if="versions.length === 0" class="empty">
          还没有存过版本。每次在导出页点「下载刀路」都会自动存一版（连同切割参数与连刀点设置），改完参数再导出一版后回到这里比对。
        </div>
        <div v-else class="ver-pickers">
          <div class="picker">
            <div class="picker-title"><span class="tag a">旧版 A</span>
              <select v-model="aId">
                <option value="" disabled>选择旧版…</option>
                <option v-for="v in versions" :key="v.id" :value="v.id">{{ v.label }}｜{{ formatFullTime(v.createdAt) }}</option>
              </select>
            </div>
          </div>
          <button class="tiny swap" title="交换两版" @click="swapSides">⇄</button>
          <div class="picker">
            <div class="picker-title"><span class="tag b">新版 B</span>
              <select v-model="bId">
                <option value="" disabled>选择新版…</option>
                <option v-for="v in versions" :key="v.id" :value="v.id">{{ v.label }}｜{{ formatFullTime(v.createdAt) }}</option>
              </select>
            </div>
          </div>
        </div>

        <div v-if="message" :class="['compare-msg', message.kind]">{{ message.text }}</div>

        <div v-if="diff" class="summary-grid">
          <div class="sum-stat">
            <div class="k">刀路总长</div>
            <div class="v">{{ fmtMm(diff.totals.cutA) }} <small>→</small> {{ fmtMm(diff.totals.cutB) }}</div>
            <div :class="['delta', diff.totals.dCut >= 0 ? 'up' : 'down']">差 {{ fmtSignedMm(diff.totals.dCut) }}</div>
          </div>
          <div class="sum-stat">
            <div class="k">跳刀总长</div>
            <div class="v">{{ fmtMm(diff.totals.travelA) }} <small>→</small> {{ fmtMm(diff.totals.travelB) }}</div>
            <div :class="['delta', diff.totals.dTravel >= 0 ? 'up' : 'down']">差 {{ fmtSignedMm(diff.totals.dTravel) }}</div>
          </div>
          <div class="sum-stat">
            <div class="k">预计切割时间</div>
            <div class="v">{{ fmtSeconds(diff.totals.secA) }} <small>→</small> {{ fmtSeconds(diff.totals.secB) }}</div>
            <div :class="['delta', diff.totals.dSec >= 0 ? 'up' : 'down']">差 {{ fmtSignedSeconds(diff.totals.dSec) }}</div>
          </div>
          <div class="sum-stat">
            <div class="k">段数 / 连刀点</div>
            <div class="v">{{ diff.totals.runsA }} 段 / {{ diff.totals.bridgesA }} 点 <small>→</small> {{ diff.totals.runsB }} 段 / {{ diff.totals.bridgesB }} 点</div>
            <div class="delta dim">含落刀/空移估算，材料 {{ diff.a.material.speedMmS }}mm/s × {{ diff.a.material.passes }}</div>
          </div>
        </div>

        <div v-if="diff && diff.paramChanges.length > 0" class="param-table">
          <div class="section-title" style="margin-top: 8px">这两版之间改了哪些参数</div>
          <table>
            <thead>
              <tr><th>分组</th><th>参数</th><th><span class="tag a">旧版 A</span></th><th><span class="tag b">新版 B</span></th></tr>
            </thead>
            <tbody>
              <tr v-for="(c, i) in diff.paramChanges" :key="i">
                <td>{{ c.group }}</td>
                <td>{{ c.label }}</td>
                <td class="a-text">{{ c.a }}</td>
                <td class="b-text">{{ c.b }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-else-if="diff" class="hint" style="margin-top: 6px">两版切割参数 / 连刀点设置完全一致，差异只来自纹样几何或手工连刀点。</div>
      </div>
    </div>

    <template v-if="diff">
      <!-- 画布 -->
      <div class="panel canvas-panel">
        <div class="panel-head">
          对照图（整场）
          <span class="spacer"></span>
          <label class="mini-check"><input type="checkbox" v-model="showCommon" /> 共有段用灰色</label>
          <label class="mini-check"><input type="checkbox" v-model="showTravels" /> 显示跳刀</label>
          <label class="mini-check"><input type="checkbox" v-model="showBridges" /> 显示连刀点</label>
        </div>
        <PreviewCanvas
          ref="canvas"
          :shapes="syntheticShapes"
          :computed="new Map()"
          mode="toolpath"
          tool="pan"
          :sheet="sheet"
          :hide-builtin="true"
          :show-grid="true"
          :show-numbers="false"
          :show-travel="false"
          :magnify="false"
          :overlay-paths="overlayPaths"
          :overlay-bridges="overlayBridges"
          :overlay-travels="overlayTravels"
          :focus-marker="focusMarker"
          :status-text="statusText"
        />
        <div class="legend-bar">
          <span><i class="swatch a"></i>旧版 A 独有 / 旧版刀路</span>
          <span><i class="swatch b"></i>新版 B 独有 / 新版刀路</span>
          <span><i class="swatch common"></i>两版共有</span>
          <span><i class="swatch hi"></i>当前选中条目</span>
          <span class="hint">点右侧任意一条 → 图上黄圈定位并高亮相关段</span>
        </div>
      </div>

      <!-- 差异清单 -->
      <div class="panel diff-panel">
        <div class="panel-head">
          差异清单 · {{ diff.rows.length }} 条
          <span class="spacer"></span>
          <button class="tiny primary" @click="downloadDiffReport(diff)">导出清单文件 (.md)</button>
        </div>
        <div class="panel-body flush scroll-list">
          <div v-if="diff.rows.length === 0" class="empty">两版刀路完全一致，没有差异（几何指纹相同）。</div>
          <div v-for="g in groupedRows" :key="g.type" class="diff-group">
            <div class="diff-group-title">
              <span :class="groupTagClass(g.type)"></span>
              {{ g.title }}
              <span class="muted">（{{ g.rows.length }} 条）</span>
            </div>
            <div
              v-for="row in g.rows"
              :key="row.key"
              :class="['diff-row', { active: row.key === selectedRowKey }]"
              @click="jumpTo(row)"
            >
              <div class="diff-row-title">
                <span :class="['dot', row.type.includes('_a') ? 'a' : row.type.includes('_b') ? 'b' : 'chg']"></span>
                {{ row.title }}
              </div>
              <div class="diff-row-detail">{{ row.detail }}</div>
              <div class="diff-row-where mono">@ ({{ row.where.x.toFixed(1) }}, {{ row.where.y.toFixed(1) }}) mm</div>
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- 版本管理 -->
    <div class="panel" v-if="versions.length > 0">
      <div class="panel-head">
        版本库（本项目 {{ versions.length }} 版，多形状/多图层按整场存档）
      </div>
      <div class="panel-body">
        <div class="prune-bar">
          <label>只留最近</label>
          <input type="number" min="1" max="999" v-model.number="keepN" class="keep-input" />
          <label>版</label>
          <button class="tiny" @click="onExecutePrune">整理旧版</button>
          <span class="spacer"></span>
          <span v-if="prunePlan" class="hint">
            将删除 {{ prunePlan.toDelete.length }} 个旧版
            <template v-if="prunePlan.protectedItems.length > 0">
              ；{{ prunePlan.protectedItems.length }} 个旧版因被对照引用而保留：
              <span v-for="(it, i) in prunePlan.protectedItems" :key="it.version.id">
                「{{ it.version.label }}」（{{ it.comparisons.length }} 次对照）{{ i < prunePlan.protectedItems.length - 1 ? '、' : '' }}
              </span>
            </template>
            <template v-else>；当前没有对照引用任何旧版，删除不影响已有对照。</template>
          </span>
        </div>

        <table class="ver-table">
          <thead>
            <tr><th>版本</th><th>时间</th><th>来源</th><th>参数要点</th><th>总长/跳刀/预计</th><th>对照引用</th><th></th></tr>
          </thead>
          <tbody>
            <tr v-for="v in versions" :key="v.id" :class="{ inuse: activePair && (activePair[0] === v.id || activePair[1] === v.id) }">
              <td>
                <button class="linklike" @click="onRename(v)">{{ v.label }} ✎</button>
                <span v-if="activePair && (activePair[0] === v.id || activePair[1] === v.id)" class="tag accent">比对中</span>
              </td>
              <td class="mono">{{ formatFullTime(v.createdAt) }}</td>
              <td class="mono">{{ v.sourceFormat }}</td>
              <td class="param-cell">
                连刀 {{ v.settings.bridgeWidthMm }}mm
                <template v-if="v.settings.bridgeRule === 'by_area'">·按面积</template>
                <template v-else-if="v.settings.bridgeRule === 'by_length'">·每 {{ v.settings.bridgeEveryMm }}mm</template>
                <template v-else>·手工</template>
                ｜跳刀 {{ v.settings.travelOptimize === 'nearest_2opt' ? 'NN+2opt' : 'NN' }}
                <template v-if="v.batch && v.batch.enabled">｜排版 {{ v.batch.cols }}×{{ v.batch.rows }}{{ v.batch.sharedEdge ? ' 共边' : '' }}</template>
              </td>
              <td class="mono">{{ v.stats.cutLengthMm.toFixed(0) }} / {{ v.stats.travelMm.toFixed(0) }} / {{ fmtSeconds(v.stats.estimatedSeconds) }}</td>
              <td>
                <span v-if="comparisonsOf(project.id).filter((c) => c.aId === v.id || c.bId === v.id).length" class="tag info">
                  {{ comparisonsOf(project.id).filter((c) => c.aId === v.id || c.bId === v.id).length }} 次对照
                </span>
                <span v-else class="muted">—</span>
              </td>
              <td>
                <button
                  class="tiny danger"
                  :disabled="!!(activePair && (activePair[0] === v.id || activePair[1] === v.id))"
                  :title="activePair && (activePair[0] === v.id || activePair[1] === v.id) ? '正在用于比对的版本不许删' : '删除该版本'"
                  @click="onDeleteVersion(v)"
                >删</button>
              </td>
            </tr>
          </tbody>
        </table>

        <div v-if="savedComparisons.length > 0" class="saved-cmp">
          <div class="section-title">已保存的对照（{{ savedComparisons.length }}）</div>
          <div class="cmp-chips">
            <span v-for="c in savedComparisons" :key="c.id" class="cmp-chip">
              <button class="linklike" @click="aId = c.aId; bId = c.bId">
                {{ versionLabel(c.aId) }} ⇄ {{ versionLabel(c.bId) }}
              </button>
              <span class="muted mono">{{ versionTime(c.aId) ? '' : '' }}</span>
              <button class="chip-x" title="删除该对照记录（删除后即可清理相关旧版）" @click="removeComparison(c.id)">×</button>
            </span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.compare-page {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px 14px 24px;
  min-height: 0;
}

.ver-pickers {
  display: flex;
  align-items: flex-end;
  gap: 10px;
}

.picker {
  flex: 1;
}

.picker-title {
  display: flex;
  align-items: center;
  gap: 8px;
}

.picker-title select {
  flex: 1;
}

.swap {
  align-self: center;
  font-size: 15px;
}

.summary-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
  margin-top: 10px;
}

.sum-stat {
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 8px 10px;
  background: rgba(255, 255, 255, 0.02);
}

.sum-stat .k {
  font-size: 11px;
  color: var(--text-dim);
}

.sum-stat .v {
  font-size: 14px;
  margin: 3px 0;
}

.sum-stat .v small {
  color: var(--text-dim);
  margin: 0 3px;
}

.delta {
  font-size: 12px;
  font-weight: 600;
}

.delta.up {
  color: #ff8f6b;
}

.delta.down {
  color: #5fd08a;
}

.delta.dim {
  color: var(--text-dim);
  font-weight: 400;
}

.param-table table,
.ver-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  margin-top: 6px;
}

.param-table th,
.param-table td,
.ver-table th,
.ver-table td {
  border: 1px solid var(--line);
  padding: 4px 8px;
  text-align: left;
}

.param-table th,
.ver-table th {
  color: var(--text-dim);
  font-weight: 500;
  background: rgba(255, 255, 255, 0.03);
}

.a-text {
  color: #8ab8f0;
}

.b-text {
  color: #f09a9a;
}

.param-cell {
  color: var(--text-dim);
  font-size: 11px;
}

.compare-msg {
  margin-top: 8px;
  padding: 6px 10px;
  border-radius: 5px;
  font-size: 12px;
}

.compare-msg.ok {
  border: 1px solid #2e7d4f;
  background: rgba(71, 192, 122, 0.1);
  color: #83dca7;
}

.compare-msg.err {
  border: 1px solid #8d3b3b;
  background: rgba(255, 107, 107, 0.12);
  color: #ff9c9c;
}

.legend-bar {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 5px 10px;
  border-top: 1px solid var(--line);
  font-size: 11px;
  color: var(--text-dim);
  flex-wrap: wrap;
}

.swatch {
  display: inline-block;
  width: 14px;
  height: 3px;
  border-radius: 2px;
  margin-right: 4px;
  vertical-align: middle;
}

.swatch.a {
  background: #4ea1ff;
}

.swatch.b {
  background: #ff6b6b;
}

.swatch.common {
  background: #5c6b7c;
}

.swatch.hi {
  background: #ffe14d;
}

.mini-check {
  font-size: 11px;
  color: var(--text-dim);
  display: flex;
  gap: 3px;
  align-items: center;
}

.diff-panel {
  max-height: 46vh;
  display: flex;
  flex-direction: column;
}

.scroll-list {
  overflow: auto;
}

.diff-group-title {
  font-size: 12px;
  font-weight: 600;
  padding: 8px 10px 4px;
  position: sticky;
  top: 0;
  background: var(--bg-panel, #141920);
  z-index: 1;
}

.muted {
  color: var(--text-dim);
  font-weight: 400;
}

.diff-row {
  margin: 2px 8px;
  padding: 6px 10px;
  border: 1px solid transparent;
  border-radius: 5px;
  cursor: pointer;
}

.diff-row:hover {
  background: rgba(255, 255, 255, 0.04);
}

.diff-row.active {
  border-color: #ffe14d;
  background: rgba(255, 225, 77, 0.08);
}

.diff-row-title {
  font-size: 12.5px;
  display: flex;
  align-items: center;
  gap: 6px;
}

.diff-row-detail {
  font-size: 11px;
  color: var(--text-dim);
  margin-top: 2px;
}

.diff-row-where {
  font-size: 10.5px;
  color: #8a98a8;
  margin-top: 1px;
}

.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: none;
}

.dot.a {
  background: #4ea1ff;
}

.dot.b {
  background: #ff6b6b;
}

.dot.chg {
  background: #ffc857;
}

.tag.a {
  background: rgba(78, 161, 255, 0.18);
  color: #8ab8f0;
}

.tag.b {
  background: rgba(255, 107, 107, 0.18);
  color: #f09a9a;
}

.tag.chg {
  background: rgba(255, 200, 87, 0.16);
  color: #e8c66a;
}

.prune-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}

.keep-input {
  width: 64px;
}

.ver-table tr.inuse td {
  background: rgba(90, 169, 255, 0.07);
}

.ver-table .danger:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.linklike {
  background: none;
  border: none;
  color: inherit;
  font: inherit;
  cursor: pointer;
  padding: 0;
}

.linklike:hover {
  color: var(--accent, #5aa9ff);
  text-decoration: underline;
}

.saved-cmp {
  margin-top: 10px;
}

.cmp-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 4px;
}

.cmp-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: 1px solid var(--line);
  border-radius: 20px;
  padding: 2px 6px 2px 10px;
  font-size: 11px;
}

.chip-x {
  border: none;
  background: none;
  color: var(--text-dim);
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
}

.chip-x:hover {
  color: #ff8f8f;
}

@media (max-width: 1100px) {
  .summary-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}
</style>
