<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import DiffCanvas from '@/components/DiffCanvas.vue'
import { store } from '@/logic/store'
import {
  DEFAULT_KEEP,
  deleteVersion,
  diffVersions,
  downloadDiffReport,
  getSelection,
  getVersion,
  listVersions,
  previewPrune,
  pruneVersions,
  protectedIds,
  recordComparison,
  saveVersion,
  setSelection,
  updateVersionNote,
  type DiffEntry,
  type VersionDiff,
} from '@/logic/versions'

const route = useRoute()
const router = useRouter()

const projectId = computed(() => String(route.params.id))
const project = computed(() => store.getProject(projectId.value) ?? null)
const material = computed(() => (project.value ? store.materialOf(project.value) : null))

const versions = computed(() => listVersions(projectId.value))
const tick = ref(0)
function refresh(): void {
  tick.value += 1
}
// 依赖 tick：删除 / 裁剪后刷新
const _refreshDep = computed(() => tick.value)

const sel = computed(() => {
  void _refreshDep.value
  return getSelection(projectId.value)
})

const va = computed(() => (sel.value.a ? getVersion(projectId.value, sel.value.a) : null))
const vb = computed(() => (sel.value.b ? getVersion(projectId.value, sel.value.b) : null))

const diff = computed<VersionDiff | null>(() => {
  void _refreshDep.value
  if (va.value && vb.value && va.value.id !== vb.value.id) return diffVersions(va.value, vb.value)
  return null
})

watch(
  () => [va.value?.id, vb.value?.id],
  (ids, old) => {
    if (ids[0] && ids[1] && ids[0] !== ids[1] && (!old || ids[0] !== old[0] || ids[1] !== old[1])) {
      recordComparison(projectId.value, ids[0] as string, ids[1] as string)
    }
  },
)

const activeEntry = ref<DiffEntry | null>(null)
const filter = ref<DiffEntry['kind'] | 'all'>('all')

const shownEntries = computed(() => {
  if (!diff.value) return []
  if (filter.value === 'seg_only_a') return diff.value.entries.filter((e) => e.kind === 'seg_only_a' || e.kind === 'seg_only_b')
  return filter.value === 'all' ? diff.value.entries : diff.value.entries.filter((e) => e.kind === filter.value)
})

function pickA(id: string): void {
  setSelection(projectId.value, { a: id || null })
  activeEntry.value = null
}
function pickB(id: string): void {
  setSelection(projectId.value, { b: id || null })
  activeEntry.value = null
}
function swapSides(): void {
  const s = sel.value
  setSelection(projectId.value, { a: s.b, b: s.a })
  activeEntry.value = null
}

function selectEntry(e: DiffEntry): void {
  activeEntry.value = e
}

// ---------------- 立即存档 ----------------
const saving = ref(false)
const saveMsg = ref('')

function snapshotCurrent(): void {
  const p = project.value
  if (!p) return
  saving.value = true
  saveMsg.value = ''
  try {
    const d = store.jobOf(p)
    const out = saveVersion(p.id, {
      job: d.job,
      settings: p.settings,
      exportCfg: p.export,
      sheet: p.sheet,
      material: material.value,
      batch: p.batch,
      exportFormat: p.export.format,
    })
    refresh()
    if (out.status === 'saved') {
      saveMsg.value = out.duplicated ? `与上一版刀路和参数完全一致，未重复存档（${out.version.label}）` : `已存档：${out.version.label}`
    } else if (out.status === 'empty') {
      saveMsg.value = '当前没有可存档的刀路（项目为空）'
    } else {
      saveMsg.value = `存档失败：${out.message}`
    }
  } finally {
    saving.value = false
  }
}

// ---------------- 删除 / 留存 ----------------
const keepCount = ref(getSelection(projectId.value).keep || DEFAULT_KEEP)
const pruneConfirm = ref(false)

const prunePreview = computed(() => {
  void _refreshDep.value
  return previewPrune(projectId.value, keepCount.value)
})

const inUseIds = computed(() => {
  void _refreshDep.value
  return protectedIds(projectId.value)
})

function tryDelete(id: string): void {
  const ok = deleteVersion(projectId.value, id)
  if (!ok) return
  refresh()
}

function doPrune(): void {
  pruneVersions(projectId.value, keepCount.value)
  pruneConfirm.value = false
  refresh()
}

function fmtDate(ts: number): string {
  const d = new Date(ts)
  const p2 = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}/${d.getDate()} ${p2(d.getHours())}:${p2(d.getMinutes())}`
}

function fmtTime(sec: number): string {
  if (sec <= 0) return '0 s'
  if (sec < 60) return `${sec.toFixed(1)} s`
  return `${Math.floor(sec / 60)} 分 ${Math.round(sec % 60)} 秒`
}

function signed(v: number, digits = 1, unit = ''): string {
  return `${v > 0 ? '+' : ''}${v.toFixed(digits)}${unit}`
}

function editNote(id: string, e: Event): void {
  updateVersionNote(projectId.value, id, (e.target as HTMLTextAreaElement).value)
}

const kindBadge: Record<DiffEntry['kind'], { text: string; cls: string }> = {
  seg_only_a: { text: '仅 A 段', cls: 'a' },
  seg_only_b: { text: '仅 B 段', cls: 'b' },
  bridge: { text: '连刀点', cls: 'bridge' },
  travel: { text: '跳刀', cls: 'travel' },
}

function entryCount(kind: DiffEntry['kind']): number {
  return diff.value?.entries.filter((e) => e.kind === kind).length ?? 0
}

// 留存设置的保护提示（选择 A/B 时不许删）
const sheetW = computed(() => Math.max(va.value?.params.sheetWidthMm ?? 0, vb.value?.params.sheetWidthMm ?? 0))
const sheetH = computed(() => Math.max(va.value?.params.sheetHeightMm ?? 0, vb.value?.params.sheetHeightMm ?? 0))
</script>

<template>
  <div v-if="!project" class="splash">项目不存在，请返回纹样库 <RouterLink to="/">返回</RouterLink></div>
  <div v-else class="workbench-compare">
    <!-- 左：对照画布 -->
    <div class="panel canvas-panel">
      <div class="panel-head">
        版本对照
        <span class="spacer"></span>
        <span v-if="va" class="tag side-a">A · {{ va.label }}</span>
        <span v-if="vb" class="tag side-b">B · {{ vb.label }}</span>
      </div>
      <DiffCanvas v-if="diff" :diff="diff" :active-entry="activeEntry" :sheet-w="sheetW" :sheet-h="sheetH" />
      <div v-else class="empty-canvas">
        <div>
          <p>请在右侧选择要对照的两个版本（A / B）。</p>
          <p class="hint">每次导出刀路都会自动存一版，也可以点「把当前刀路存一版」手动存档。多形状与多图层按整场保存。</p>
        </div>
      </div>
      <div class="panel-foot">
        <div class="legend-row">
          <span class="hint">拖动平移 · 滚轮缩放 · 点右侧差异条目自动跳到图上对应位置</span>
        </div>
      </div>
    </div>

    <!-- 右：控制栏 -->
    <div class="panel side-panel">
      <div class="panel-body">
        <!-- 选版 -->
        <div class="section">
          <div class="section-title">选择对照版本</div>
          <div class="pick-row">
            <label class="side-a">A 版</label>
            <select :value="sel.a ?? ''" @change="pickA(($event.target as HTMLSelectElement).value)">
              <option value="" disabled>选择旧版…</option>
              <option v-for="v in versions" :key="v.id" :value="v.id">{{ v.label }} · {{ v.exportFormat.toUpperCase() }}</option>
            </select>
          </div>
          <div class="pick-row">
            <label class="side-b">B 版</label>
            <select :value="sel.b ?? ''" @change="pickB(($event.target as HTMLSelectElement).value)">
              <option value="" disabled>选择新版…</option>
              <option v-for="v in versions" :key="v.id" :value="v.id">{{ v.label }} · {{ v.exportFormat.toUpperCase() }}</option>
            </select>
          </div>
          <div class="btn-row" style="margin-top: 6px">
            <button class="tiny" :disabled="!sel.a || !sel.b" @click="swapSides">A / B 互换</button>
            <button class="tiny" :disabled="saving" @click="snapshotCurrent">把当前刀路存一版</button>
            <button class="tiny" @click="router.push(`/export/${project.id}`)">去导出页</button>
          </div>
          <div v-if="saveMsg" class="hint save-msg">{{ saveMsg }}</div>
        </div>

        <!-- 三项差值 -->
        <div v-if="diff" class="section">
          <div class="section-title">三项总差值（B − A）</div>
          <table class="grid metrics">
            <thead>
              <tr><th>指标</th><th class="num">A</th><th class="num">B</th><th class="num">差值</th></tr>
            </thead>
            <tbody>
              <tr>
                <td>刀路总长</td>
                <td class="num">{{ diff.a.stats.cutLengthMm.toFixed(1) }}</td>
                <td class="num">{{ diff.b.stats.cutLengthMm.toFixed(1) }}</td>
                <td class="num delta" :class="diff.metrics.cutDeltaMm > 0 ? 'up' : diff.metrics.cutDeltaMm < 0 ? 'down' : ''">
                  {{ signed(diff.metrics.cutDeltaMm, 1) }} mm
                </td>
              </tr>
              <tr>
                <td>跳刀总长</td>
                <td class="num">{{ diff.a.stats.travelMm.toFixed(1) }}</td>
                <td class="num">{{ diff.b.stats.travelMm.toFixed(1) }}</td>
                <td class="num delta" :class="diff.metrics.travelDeltaMm > 0 ? 'up' : diff.metrics.travelDeltaMm < 0 ? 'down' : ''">
                  {{ signed(diff.metrics.travelDeltaMm, 1) }} mm
                </td>
              </tr>
              <tr>
                <td>预计切割时间</td>
                <td class="num">{{ fmtTime(diff.a.stats.cutTimeSec) }}</td>
                <td class="num">{{ fmtTime(diff.b.stats.cutTimeSec) }}</td>
                <td class="num delta" :class="diff.metrics.cutTimeDeltaSec > 0 ? 'up' : diff.metrics.cutTimeDeltaSec < 0 ? 'down' : ''">
                  {{ signed(diff.metrics.cutTimeDeltaSec, 1) }} s
                </td>
              </tr>
              <tr>
                <td>切割段 / 连刀点 / 跳刀次数</td>
                <td class="num">{{ diff.a.stats.runCount }} / {{ diff.a.stats.bridgeCount }} / {{ diff.a.travels.length }}</td>
                <td class="num">{{ diff.b.stats.runCount }} / {{ diff.b.stats.bridgeCount }} / {{ diff.b.travels.length }}</td>
                <td class="num dim">—</td>
              </tr>
            </tbody>
          </table>
          <div v-if="diff.identical" class="banner ok">两版刀路、连刀点与跳刀完全一致（参数若有差异见下表）。</div>
        </div>

        <!-- 差异清单 -->
        <div v-if="diff" class="section">
          <div class="section-title">
            差异清单（{{ diff.entries.length }}）
            <span class="spacer"></span>
            <button class="tiny" :disabled="diff.entries.length === 0" @click="downloadDiffReport(project.name, diff)">导出清单 .txt</button>
          </div>
          <div class="filter-row">
            <button class="tiny" :class="{ active: filter === 'all' }" @click="filter = 'all'">全部 {{ diff.entries.length }}</button>
            <button class="tiny" :class="{ active: filter === 'seg_only_a' || filter === 'seg_only_b' }" @click="filter = 'seg_only_a'">
              切割段 {{ entryCount('seg_only_a') + entryCount('seg_only_b') }}
            </button>
            <button class="tiny" :class="{ active: filter === 'bridge' }" @click="filter = 'bridge'">连刀点 {{ entryCount('bridge') }}</button>
            <button class="tiny" :class="{ active: filter === 'travel' }" @click="filter = 'travel'">跳刀 {{ entryCount('travel') }}</button>
          </div>
          <div class="entry-list">
            <div
              v-for="e in shownEntries"
              :key="e.id"
              class="list-item entry"
              :class="{ active: activeEntry?.id === e.id }"
              @click="selectEntry(e)"
            >
              <span class="badge" :class="kindBadge[e.kind].cls">{{ kindBadge[e.kind].text }}</span>
              <span class="grow">
                <div class="e-title">{{ e.title }}</div>
                <div class="e-detail">{{ e.detail }}</div>
              </span>
            </div>
            <div v-if="shownEntries.length === 0" class="empty">该分类下没有差异</div>
          </div>
        </div>

        <!-- 参数变化 -->
        <div v-if="diff && diff.changedParams.length > 0" class="section">
          <div class="section-title">切割参数变化（{{ diff.changedParams.length }}）</div>
          <table class="grid">
            <thead>
              <tr><th>参数</th><th>A</th><th>B</th></tr>
            </thead>
            <tbody>
              <tr v-for="c in diff.changedParams" :key="c.key">
                <th>{{ c.label }}</th>
                <td>{{ c.a }}</td>
                <td class="changed">{{ c.b }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- 版本库管理 -->
        <div class="section">
          <div class="section-title">版本库（{{ versions.length }} 版）</div>
          <div class="retention-bar">
            <label>只留最近</label>
            <input type="number" min="2" max="200" v-model.number="keepCount" />
            <label>版</label>
            <button class="tiny danger" :disabled="versions.length <= keepCount" @click="pruneConfirm = true">清理旧版</button>
          </div>
          <div class="hint">正在用于比对的 A / B 版本不会被删。</div>

          <div class="version-list">
            <div v-for="v in versions" :key="v.id" class="version-card" :class="{ usedA: sel.a === v.id, usedB: sel.b === v.id }">
              <div class="vc-head">
                <span class="vc-label">
                  <i v-if="sel.a === v.id" class="dot side-a-bg">A</i>
                  <i v-else-if="sel.b === v.id" class="dot side-b-bg">B</i>
                  {{ v.label }}
                </span>
                <span class="tag mono">{{ v.exportFormat.toUpperCase() }}</span>
              </div>
              <div class="vc-meta mono">
                {{ fmtDate(v.createdAt) }} · {{ v.stats.runCount }} 段 · {{ v.stats.cutLengthMm.toFixed(0) }}mm · 跳刀
                {{ v.stats.travelMm.toFixed(0) }}mm · {{ fmtTime(v.stats.cutTimeSec) }}
              </div>
              <textarea
                class="vc-note"
                rows="1"
                :value="v.note"
                placeholder="备注（改了什么参数）"
                @change="editNote(v.id, $event)"
              ></textarea>
              <div class="vc-actions">
                <button class="tiny" :disabled="sel.b === v.id" @click="sel.a === v.id ? pickA('') : pickA(v.id)">
                  {{ sel.a === v.id ? '取消 A' : '选为 A' }}
                </button>
                <button class="tiny" :disabled="sel.a === v.id" @click="sel.b === v.id ? pickB('') : pickB(v.id)">
                  {{ sel.b === v.id ? '取消 B' : '选为 B' }}
                </button>
                <button
                  class="tiny danger"
                  style="margin-left: auto"
                  :disabled="inUseIds.has(v.id)"
                  :title="inUseIds.has(v.id) ? '正在用于比对，不许删除' : '删除该版'"
                  @click="tryDelete(v.id)"
                >
                  删除
                </button>
              </div>
            </div>
            <div v-if="versions.length === 0" class="empty">还没有存档。导出一版刀路，或点上面的「把当前刀路存一版」。</div>
          </div>
        </div>
      </div>
    </div>

    <!-- 裁剪确认弹层 -->
    <div v-if="pruneConfirm" class="modal-mask" @click.self="pruneConfirm = false">
      <div class="modal">
        <h3>只留最近 {{ keepCount }} 版？</h3>
        <p class="hint">
          将删除 <strong class="n-del">{{ prunePreview.candidates.length }}</strong> 个旧版本；正在比对的
          <template v-if="prunePreview.protected.length">
            {{ prunePreview.protected.map((v) => v.label).join('、') }}
          </template>
          <template v-else>无</template>
          受保护、不会删除。
        </p>
        <div v-if="prunePreview.affectedComparisons.length > 0" class="affected">
          <div class="warn-title">以下 {{ prunePreview.affectedComparisons.length }} 次历史对照会受到影响（对照的一侧将被删）：</div>
          <ul>
            <li v-for="(c, i) in prunePreview.affectedComparisons.slice(0, 8)" :key="i">
              {{ c.a.label }} ⇄ {{ c.b.label }}
              <span class="hint">（{{ fmtDate(c.at) }}）</span>
            </li>
            <li v-if="prunePreview.affectedComparisons.length > 8" class="hint">…等共 {{ prunePreview.affectedComparisons.length }} 次</li>
          </ul>
        </div>
        <div v-else class="hint">没有历史对照引用这些旧版。</div>
        <div class="btn-row" style="margin-top: 10px; justify-content: flex-end">
          <button class="tiny" @click="pruneConfirm = false">取消</button>
          <button class="tiny danger" @click="doPrune">确认删除 {{ prunePreview.candidates.length }} 版</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.workbench-compare {
  display: grid;
  grid-template-columns: minmax(420px, 1.35fr) minmax(360px, 1fr);
  gap: 10px;
  height: calc(100vh - 48px - 32px);
  padding: 10px;
}

.side-panel .panel-body {
  padding: 10px;
}

.empty-canvas {
  flex: 1 1 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-mute);
  text-align: center;
  padding: 24px;
}

.legend-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.tag.side-a {
  color: #ff9d9d;
  border-color: rgba(255, 107, 107, 0.5);
}

.tag.side-b {
  color: #8cc1ff;
  border-color: rgba(90, 169, 255, 0.5);
}

.pick-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.pick-row label {
  flex: 0 0 38px;
  font-size: 12px;
  font-weight: 700;
}

.pick-row label.side-a {
  color: #ff9d9d;
}
.pick-row label.side-b {
  color: #8cc1ff;
}

.save-msg {
  margin-top: 5px;
}

table.metrics td.delta.up {
  color: var(--err);
}
table.metrics td.delta.down {
  color: var(--ok);
}
table.metrics td.dim {
  color: var(--text-mute);
}

.filter-row {
  display: flex;
  gap: 4px;
  margin-bottom: 7px;
  flex-wrap: wrap;
}

.filter-row button.active {
  border-color: var(--accent);
  color: var(--accent-2);
}

.entry-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 280px;
  overflow: auto;
}

.entry .badge {
  flex: 0 0 auto;
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 9px;
  border: 1px solid var(--line);
  background: var(--panel-3);
  color: var(--text-dim);
}

.badge.a {
  color: #ff9d9d;
  border-color: rgba(255, 107, 107, 0.5);
}
.badge.b {
  color: #8cc1ff;
  border-color: rgba(90, 169, 255, 0.5);
}
.badge.bridge {
  color: var(--ok);
  border-color: rgba(71, 192, 122, 0.5);
}
.badge.travel {
  color: var(--warn);
  border-color: rgba(255, 200, 87, 0.5);
}

.e-title {
  font-size: 12px;
}
.e-detail {
  font-size: 10.5px;
  color: var(--text-mute);
  font-family: var(--mono);
}

td.changed {
  color: var(--accent-2);
}

.retention-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-dim);
}

.retention-bar input[type='number'] {
  width: 64px;
}

.version-list {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 320px;
  overflow: auto;
}

.version-card {
  border: 1px solid var(--line-soft);
  border-radius: 6px;
  background: var(--panel-2);
  padding: 7px 8px;
}

.version-card.usedA {
  border-color: rgba(255, 107, 107, 0.55);
}
.version-card.usedB {
  border-color: rgba(90, 169, 255, 0.55);
}

.vc-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  font-weight: 600;
}

.vc-label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.dot {
  font-style: normal;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-weight: 700;
  color: #1a1206;
}
.side-a-bg {
  background: #ff6b6b;
}
.side-b-bg {
  background: #5aa9ff;
}

.vc-meta {
  font-size: 10.5px;
  color: var(--text-mute);
  margin: 3px 0;
}

.vc-note {
  font-size: 11px;
  padding: 3px 6px;
  min-height: 0;
  resize: vertical;
}

.vc-actions {
  display: flex;
  gap: 5px;
  margin-top: 5px;
}

.banner.ok {
  margin-top: 7px;
  background: rgba(71, 192, 122, 0.1);
  border: 1px solid rgba(71, 192, 122, 0.4);
  color: #88e0ab;
  padding: 6px 9px;
  border-radius: 6px;
  font-size: 12px;
}

/* 弹层 */
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(8, 11, 14, 0.66);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
}

.modal {
  width: min(520px, 92vw);
  max-height: 80vh;
  overflow: auto;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 16px;
}

.modal h3 {
  margin-bottom: 8px;
}

.n-del {
  color: var(--err);
}

.affected {
  margin-top: 10px;
  border: 1px solid rgba(255, 200, 87, 0.4);
  background: rgba(255, 200, 87, 0.08);
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 12px;
}

.warn-title {
  color: var(--warn);
  margin-bottom: 5px;
}

.affected ul {
  margin: 0;
  padding-left: 18px;
}

.affected li {
  margin: 2px 0;
}

@media (max-width: 1180px) {
  .workbench-compare {
    grid-template-columns: minmax(0, 1fr);
    grid-auto-rows: max-content;
    height: auto;
    padding-bottom: 16px;
  }
  .workbench-compare .canvas-panel {
    height: 460px;
  }
}
</style>
