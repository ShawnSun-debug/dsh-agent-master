/**
 * dsh-agent-master — 模型工具（看板为核心）。
 *
 * 设计约束：本模块不认识看板/台账的具体实现，只认注入进来的契约方法
 * （board.createCard / updateCard / getCard / listCards / appendRecord / queryRecords / head，
 *   ledger.append / latest / list），全部由 createTools(deps) 注入 —— 测试可以全假。
 *
 * 术语与 lib/board.js 一致：卡（card）是唯一事实来源，records 是挂在卡上的证据流。
 * 工具面（T09 阶段五项；T11 加 master_dispatch、T12 加 master_experience）。
 *
 * @module dsh-agent-master/tools
 */

import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { DEFAULT_PRIORITY, PRIORITIES } from './board.js'
import { DEFAULTS, artifactsDir } from './config.js'
import { assertReportAllowed } from './gate.js'
import { bindReportToLedger, renderBrief, validateReport } from './handoff.js'
import { chooseDispatch } from './dispatch.js'
import { aggregateSources } from './sources.js'
import { childAllowList, normalizeTools } from './master.js'

/** 工具错误：参数不对、依赖缺失、看板没有卡等「调用方必须改」的失败都用它（文案中文）。 */
export class ToolsError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message)
    this.name = 'ToolsError'
  }
}

/** 模型可见的工具名（顺序即注册顺序）。 @type {ReadonlyArray<string>} */
export const TOOL_NAMES = Object.freeze([
  'master_assign',
  'master_dispatch',
  'master_report',
  'master_collect',
  'master_board',
  'master_digest',
  'master_experience',
])

/** 只有 master 会话能用的看板 op（子对话调用直接拒）。 */
const MASTER_ONLY_OPS = Object.freeze(['accept', 'create', 'reopen'])

/** 验收三种裁决（唯一的结案入口）。 */
export const ACCEPT_VERDICTS = Object.freeze(['accept', 'rework', 'abort'])

/** 卡号形状：t1、t2 ……（卡 id 即 taskId） */
const TASK_ID_PATTERN = /^t\d+$/

/** 记录里携带台账违规的 tag 前缀：violation:<kind>:<短文本> */
const VIOLATION_TAG_PREFIX = 'violation:'

/** 违规 tag 文本上限（避免把长报文塞进 tag） */
const VIOLATION_TEXT_LIMIT = 200

/** collect 等待回报时的轮询间隔（毫秒） */
const POLL_INTERVAL_MS = 10

/** 算「占着名额」的状态：done 之外的卡都算，blocked 也占（它还要人来解） */
const ACTIVE_STATUSES = Object.freeze(['todo', 'assigned', 'doing', 'review', 'blocked'])

// ---------------------------------------------------------------------------
// 依赖与参数小工具
// ---------------------------------------------------------------------------

/**
 * 校验并补齐依赖：缺什么就一次性说清，不要等到某个工具被调用才炸。
 * @param {{config?: object, board?: object, ledger?: object, spawnActivation?: Function, rootId?: string, now?: Function}} deps
 * @returns {{cfg: Record<string, any>, board: any, ledger: any, spawnActivation: Function, rootId: string, now: () => number}}
 */
function resolveDeps(deps) {
  if (!deps || typeof deps !== 'object') {
    throw new ToolsError('createTools 需要依赖对象 deps（config/board/ledger/spawnActivation/rootId）')
  }
  const missing = []
  if (!deps.config || typeof deps.config !== 'object') missing.push('config')
  if (
    !deps.board ||
    typeof deps.board.listCards !== 'function' ||
    typeof deps.board.createCard !== 'function' ||
    // 回滚（spawn 失败丢卡）依赖它：缺了要在装配期报错，不能等回滚时才 TypeError
    typeof deps.board.discardCard !== 'function'
  ) {
    missing.push('board（需提供 createCard/listCards/updateCard/getCard/appendRecord/queryRecords/discardCard）')
  }
  if (!deps.ledger || typeof deps.ledger.append !== 'function') {
    missing.push('ledger（需提供 append）')
  }
  if (typeof deps.spawnActivation !== 'function') missing.push('spawnActivation')
  if (typeof deps.rootId !== 'string' || deps.rootId.trim() === '') missing.push('rootId')
  if (missing.length > 0) {
    throw new ToolsError('createTools 缺少必需依赖：' + missing.join('、'))
  }
  return {
    cfg: { ...DEFAULTS, ...deps.config },
    board: deps.board,
    ledger: deps.ledger,
    spawnActivation: deps.spawnActivation,
    rootId: deps.rootId.trim(),
    now: typeof deps.now === 'function' ? deps.now : () => Date.now(),
    // 经验库可选：注入缺失时 master_experience / op=accept 会给出明确报错，而不是静默降级
    experience: deps.experience ?? null,
  }
}

/**
 * 取非空字符串，失败抛 ToolsError（文案带字段名，模型能照着改）
 * @param {unknown} value
 * @param {string} name
 * @returns {string}
 */
function requireText(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ToolsError(name + ' 必须是非空字符串，实际收到 ' + JSON.stringify(value))
  }
  return value.trim()
}

/**
 * brief 里的四组条目：字符串、{ text } 对象、或它们的数组；空值归一成 []。
 * 归一只是收敛形状，条目文本一条都不丢（台账才是权威）。
 * @param {unknown} value
 * @returns {any[]}
 */
export function toLedgerItems(value) {
  if (value === undefined || value === null || value === '') return []
  const list = Array.isArray(value) ? value : [value]
  return list.filter((item) => item !== undefined && item !== null && item !== '')
}

/**
 * 校验 taskId 形状（卡 id 即 taskId）
 * @param {unknown} value
 * @returns {string}
 */
function requireTaskId(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!TASK_ID_PATTERN.test(text)) {
    throw new ToolsError('taskId 必须形如 t1、t2（卡的 id），实际收到 ' + JSON.stringify(value))
  }
  return text
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function isHttpUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * 把文本压成一行短 tag（tag 是字符串数组，放不下换行）
 * @param {unknown} value
 * @returns {string}
 */
function oneLine(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, VIOLATION_TEXT_LIMIT)
}

/**
 * 解析子对话传入的运行时上下文，决定 actor（sessionId/name）。
 * 宿主接线时应把子会话的 sessionId/name 透传进来；拿不到就退化成 rootId/child，
 * 此时 collect 仍能工作，但归属核对会失真，所以接线时要传。
 * @param {unknown} runtime
 * @param {{sessionId: string, name: string}} fallback
 * @returns {{sessionId: string, name: string}}
 */
function resolveCaller(runtime, fallback) {
  if (runtime && typeof runtime === 'object') {
    const author = /** @type {any} */ (runtime).author
    if (author && typeof author === 'object' && typeof author.sessionId === 'string' && author.sessionId !== '') {
      return {
        sessionId: author.sessionId,
        name: typeof author.name === 'string' && author.name !== '' ? author.name : fallback.name,
      }
    }
    const direct = /** @type {any} */ (runtime)
    if (typeof direct.sessionId === 'string' && direct.sessionId !== '') {
      return {
        sessionId: direct.sessionId,
        name: typeof direct.name === 'string' && direct.name !== '' ? direct.name : fallback.name,
      }
    }
  }
  return { ...fallback }
}

/**
 * 卡标题的排序键：按卡号数字排（t2 在 t10 之前），非 tN 的排最后。
 * @param {string} id
 * @returns {number}
 */
function cardOrder(id) {
  const match = TASK_ID_PATTERN.exec(String(id))
  return match === null ? Number.MAX_SAFE_INTEGER : Number(String(id).slice(1))
}

// ---------------------------------------------------------------------------
// createTools
// ---------------------------------------------------------------------------

/**
 * 造出工具集。依赖全部注入，调用方（lib/index.js）负责接线，测试负责造假。
 *
 * @param {{config?: Record<string, any>, board?: any, ledger?: any, spawnActivation?: Function, rootId?: string, now?: () => number}} deps
 */
export function createTools(deps = {}) {
  const { cfg, board, ledger, spawnActivation, rootId, now, experience } = resolveDeps(deps)

  /** master 自己的 actor（建卡、验收、丢弃都由它发起） */
  const masterActor = Object.freeze({ sessionId: rootId, name: 'master', role: 'master' })

  /** @param {unknown} runtime @returns {any} 子对话 actor */
  function childActor(runtime) {
    const caller = resolveCaller(runtime, { sessionId: rootId, name: 'child' })
    return { sessionId: caller.sessionId, name: caller.name, role: 'child' }
  }

  // -------------------------------------------------------------------------
  // taskId 分配与查卡
  // -------------------------------------------------------------------------

  /**
   * 下一个卡号：卡号即任务号，按板上最大 tN 递增；再排除台账里出现过的号，
   * 避免「建卡后 spawn 失败被丢弃」的那个号被下一个任务复用成同号不同任务。
   * @returns {Promise<string>}
   */
  async function generateTaskId() {
    const cards = (await board.listCards({ limit: cfg.maxCards })) ?? []
    /** @type {Set<string>} */
    const used = new Set()
    let max = 0
    for (const card of cards) {
      used.add(card.id)
      const match = /^t(\d+)$/.exec(card.id)
      if (match !== null) max = Math.max(max, Number(match[1]))
    }
    if (typeof ledger.list === 'function') {
      try {
        const entries = await ledger.list()
        for (const entry of entries ?? []) {
          if (entry && typeof entry.taskId === 'string' && TASK_ID_PATTERN.test(entry.taskId)) {
            const match = /^t(\d+)$/.exec(entry.taskId)
            if (match !== null) max = Math.max(max, Number(match[1]))
            used.add(entry.taskId)
          }
        }
      } catch {
        // 台账只读失败不该挡住下派：看板上的卡号已经足够生成不冲突的号
      }
    }
    let index = max + 1
    while (used.has('t' + index)) index += 1
    return 't' + index
  }

  /**
   * 按卡号取卡；没有就抛出「该先更新看板」的行动指引（不自行造卡）。
   * @param {string} cardId
   * @returns {Promise<any>}
   */
  async function requireCard(cardId) {
    try {
      return await board.getCard(cardId)
    } catch {
      throw new ToolsError(
        '看板上没有卡 ' + cardId + '：先确认卡号（master_board op=query 看整块板），不要自行造卡',
      )
    }
  }

  /**
   * 占着名额的卡数（done 之外都算）。
   * @returns {Promise<number>}
   */
  async function activeCardCount() {
    const cards = (await board.listCards({ limit: cfg.maxCards })) ?? []
    return cards.filter((card) => ACTIVE_STATUSES.includes(card.status)).length
  }

  // -------------------------------------------------------------------------
  // 1. master_assign
  // -------------------------------------------------------------------------

  /**
   * 下派一路任务：建卡（todo）→ 写约束台账 → 渲染交接契约 → 开子会话 → 登记子会话 id。
   *
   * 顺序有意：**先建卡再 spawn**，这样「本批卡已在板上」成立；spawn 失败则把刚建的卡丢掉
   * （discardCard 只允许丢 todo 且无记录的卡，不会误删有审计价值的卡）。
   * 台账是 append-only，失败后用同一个 taskId 重试即可。
   *
   * @param {{label?: string, name?: string, taskId?: string, priority?: string, tools?: string[], brief?: object}} [input]
   */
  async function assign(input = {}) {
    const label = requireText(input?.label, 'label')
    const name = typeof input?.name === 'string' && input.name.trim() !== '' ? input.name.trim() : null
    const brief = input?.brief
    if (!brief || typeof brief !== 'object' || Array.isArray(brief)) {
      throw new ToolsError('master_assign 需要 brief 对象（至少含 goal）')
    }
    const goal = requireText(brief.goal, 'brief.goal')
    const priority = input?.priority === undefined ? DEFAULT_PRIORITY : String(input.priority)
    if (!PRIORITIES.includes(priority)) {
      throw new ToolsError('priority 只能是 ' + PRIORITIES.join(' / ') + '，实际收到 ' + JSON.stringify(input?.priority))
    }

    /** @type {string[] | null} */
    let childTools
    try {
      childTools = childAllowList(normalizeTools(input?.tools, 'tools'), cfg.childToolExtras ?? undefined)
    } catch (error) {
      throw new ToolsError(String((error && error.message) || error))
    }

    if ((await activeCardCount()) >= cfg.maxChildren) {
      throw new ToolsError(
        '已达 maxChildren 上限（' + cfg.maxChildren + '）：先 master_collect 回收并用 master_board op=accept 验收结案，再下派新任务',
      )
    }

    const taskId = input?.taskId === undefined || input.taskId === null
      ? await generateTaskId()
      : requireTaskId(input.taskId)

    // 约束台账：唯一权威来源，先落台账再渲染，渲染时只可能是台账里的条目
    const ledgerEntry = await ledger.append({
      taskId,
      constraints: toLedgerItems(brief.constraints),
      acceptance: toLedgerItems(brief.acceptance),
      boundaries: toLedgerItems(brief.boundaries),
      forbidden: toLedgerItems(brief.forbidden),
    })
    if (!ledgerEntry || typeof ledgerEntry !== 'object' || ledgerEntry.taskId !== taskId) {
      throw new ToolsError('台账没有为 ' + taskId + ' 返回条目：拒绝在没有台账绑定的情况下下派')
    }
    const ledgerVersion = Number.isSafeInteger(ledgerEntry.version) ? ledgerEntry.version : 1

    // 先建卡：卡是唯一事实来源，子对话开工第一件事就是认领它
    const card = await board.createCard({
      id: taskId,
      title: goal,
      body: toLedgerItems(brief.inputs).map((item) => String(item)).join('\n'),
      priority,
      actor: masterActor,
    })

    // 交接契约必须复用 lib/handoff.js 的渲染，不要在工具层自己拼 prompt
    const prompt = renderBrief({ taskId, label, brief, ledgerEntry })
    const promptBytes = Buffer.byteLength(prompt, 'utf8')

    let child
    try {
      child = await spawnActivation({
        label,
        ...(name === null ? {} : { name }),
        prompt,
        ...(childTools === null ? {} : { tools: childTools }),
      })
    } catch (error) {
      // 回滚：刚建的卡还没被碰过，丢掉；台账条目保留供同号重试
      await board.discardCard(taskId, { actor: masterActor, reason: 'spawn 失败回滚' }).catch(() => {})
      return {
        ok: false,
        taskId,
        ledgerVersion,
        promptBytes,
        error: {
          name: String((error && error.name) || 'Error'),
          message: String((error && error.message) || error),
        },
      }
    }

    // 登记子会话 id（只为指挥台开 tab；归属仍由子对话认领时写入）
    const childSessionId = child && typeof child.sessionId === 'string'
      ? child.sessionId
      : child && typeof child.childId === 'string' ? child.childId : null
    /** @type {any} */
    let finalCard = card
    if (childSessionId !== null) {
      try {
        const patched = await board.updateCard({
          cardId: taskId,
          rev: card.rev,
          childSessionId,
          actor: masterActor,
        })
        finalCard = patched.card
      } catch (error) {
        // 登记失败不影响下派：子对话照样能按 taskId 认领
      }
    }

    return {
      ok: true,
      taskId,
      cardId: finalCard.id,
      status: finalCard.status,
      priority: finalCard.priority,
      promptBytes,
      child,
      childSessionId,
      tools: childTools,
    }
  }

  // -------------------------------------------------------------------------
  // 1b. master_dispatch（批量派发：整批一次审批）
  // -------------------------------------------------------------------------

  /**
   * 数一份 brief 里某一组条目的条数（字符串算 1 条）。
   * @param {unknown} value
   * @returns {number}
   */
  function countItems(value) {
    if (value === undefined || value === null || value === '') return 0
    return Array.isArray(value) ? value.length : 1
  }

  /**
   * 批量派发：一次调用派 N 路，整批只弹**一次**审批（审批在 tools/pre-execute，见 lib/approval.js）。
   *
   * 顺序与单路 assign 一致，但多了两层整批语义：
   * 1. **预检在任何一侧效应之前**：配额、每路 brief 齐备、显式 taskId 必须在板上 ——
   *    这就是「未先更新看板不进五档阶梯」：预检不过直接抛，连阶梯都不算。
   * 2. **失败整体回滚**：任一路 spawn 失败，把本批**新建**的卡全丢掉（预置的卡不动），
   *    已启动的子会话如实报告，避免 master 重复派发。
   *
   * @param {{briefs?: any[]}} [input]
   */
  async function dispatchTool(input = {}) {
    const briefs = input?.briefs
    if (!Array.isArray(briefs) || briefs.length === 0) {
      throw new ToolsError('master_dispatch 需要非空的 briefs 数组（每项至少 { label, brief.goal }）')
    }
    if (briefs.length > cfg.maxChildren) {
      throw new ToolsError('一次最多派 ' + cfg.maxChildren + ' 路（maxChildren），实际 ' + briefs.length + ' 路')
    }
    const active = await activeCardCount()
    if (active + briefs.length > cfg.maxChildren) {
      throw new ToolsError(
        '配额不足：当前活跃 ' + active + ' 张卡 + 本次 ' + briefs.length + ' 路 > 上限 ' + cfg.maxChildren +
          '；先 master_board op=accept 验收结案再派发',
      )
    }

    // ---- 预检（零副作用）：brief 齐备 + 显式 taskId 必须在板上 ----
    /** @type {any[]} */
    const prepared = []
    for (const [index, raw] of briefs.entries()) {
      const at = 'briefs[' + index + ']'
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ToolsError(at + ' 必须是对象')
      const label = requireText(raw.label, at + '.label')
      const brief = raw.brief
      if (!brief || typeof brief !== 'object' || Array.isArray(brief)) throw new ToolsError(at + '.brief 必须是对象')
      const goal = requireText(brief.goal, at + '.brief.goal')
      const constraintCount = countItems(brief.constraints) + countItems(brief.acceptance)
      if (constraintCount === 0) {
        throw new ToolsError(at + ' 约束不齐备：constraints 与 acceptance 至少要有一条（台账是逐条核对的依据）')
      }
      const priority = raw.priority === undefined ? DEFAULT_PRIORITY : String(raw.priority)
      if (!PRIORITIES.includes(priority)) {
        throw new ToolsError(at + '.priority 只能是 ' + PRIORITIES.join(' / ') + '，实际收到 ' + JSON.stringify(raw.priority))
      }
      /** @type {string | null} */
      let presetCardId = null
      if (raw.taskId !== undefined && raw.taskId !== null) {
        presetCardId = requireTaskId(raw.taskId)
        // 前置硬检查：说好的卡必须在板上，否则不进五档阶梯
        await requireCard(presetCardId)
      }
      let childTools
      try {
        childTools = childAllowList(normalizeTools(raw.tools, at + '.tools'), cfg.childToolExtras ?? undefined)
      } catch (error) {
        throw new ToolsError(String((error && error.message) || error))
      }
      prepared.push({ label, name: typeof raw.name === 'string' && raw.name !== '' ? raw.name : null, brief, goal, priority, presetCardId, childTools })
    }

    // ---- 五档阶梯（纯函数，遗留：只作派发策略提示，不决定是否发内容）----
    /** @type {any[]} */
    const routes = []
    /** @type {string[]} 本批**新建**的卡（失败时只回滚这些） */
    const createdHere = []
    let dispatched = 0

    for (const [index, item] of prepared.entries()) {
      const payloadBytes = Buffer.byteLength(JSON.stringify(item.brief), 'utf8')
      const ladder = chooseDispatch({
        payloadBytes,
        budgetBytes: cfg.digestBudgetBytes,
        childCapacity: Math.max(0, cfg.maxChildren - active - index),
        sameModelAvailability: true,
        priorAttemptFailed: false,
        sharedStateUpdated: true,
      })

      let taskId = item.presetCardId
      if (taskId === null) {
        taskId = await generateTaskId()
        await board.createCard({ id: taskId, title: item.goal, body: '', priority: item.priority, actor: masterActor })
        createdHere.push(taskId)
      }

      const ledgerEntry = await ledger.append({
        taskId,
        constraints: toLedgerItems(item.brief.constraints),
        acceptance: toLedgerItems(item.brief.acceptance),
        boundaries: toLedgerItems(item.brief.boundaries),
        forbidden: toLedgerItems(item.brief.forbidden),
      })
      if (!ledgerEntry || typeof ledgerEntry !== 'object' || ledgerEntry.taskId !== taskId) {
        throw new ToolsError('台账没有为 ' + taskId + ' 返回条目：拒绝在没有台账绑定的情况下派发')
      }
      const prompt = renderBrief({ taskId, label: item.label, brief: item.brief, ledgerEntry })

      let child
      try {
        child = await spawnActivation({
          label: item.label,
          ...(item.name === null ? {} : { name: item.name }),
          prompt,
          ...(item.childTools === null ? {} : { tools: item.childTools }),
        })
      } catch (error) {
        // 整体回滚：只丢本批新建的卡；预置卡与已启动的子会话如实报告
        const rolledBack = []
        for (const cardId of createdHere) {
          try {
            await board.discardCard(cardId, { actor: masterActor, reason: '批量派发回滚' })
            rolledBack.push(cardId)
          } catch {
            // 单张回滚失败不该打断其余回滚
          }
        }
        return {
          ok: false,
          failedAt: index + 1,
          started: dispatched,
          rolledBack,
          error: {
            name: String((error && error.name) || 'Error'),
            message: String((error && error.message) || error),
          },
        }
      }

      const childSessionId = child && typeof child.sessionId === 'string'
        ? child.sessionId
        : child && typeof child.childId === 'string' ? child.childId : null
      if (childSessionId !== null) {
        try {
          const detail = await board.getCard(taskId)
          await board.updateCard({ cardId: taskId, rev: detail.card.rev, childSessionId, actor: masterActor })
        } catch {
          // 登记失败不影响派发
        }
      }
      dispatched += 1
      routes.push({
        taskId,
        label: item.label,
        priority: item.priority,
        childSessionId,
        strategy: ladder.strategy,
        costHint: ladder.costHint,
        tools: item.childTools,
      })
    }

    return { ok: true, routes, dispatched }
  }

  // -------------------------------------------------------------------------
  // 2. master_report
  // -------------------------------------------------------------------------

  /**
   * 子对话回传结构化报告：先校验（失败直接抛、一个字节都不写），
   * 再把 finding / source / artifact / open_question 作为 records 挂到本卡，
   * 最后按台账逐条核对 violations —— 有 violations 仍然写盘，但 ok=false 并逐条列出。
   *
   * @param {unknown} raw 子对话回传的原始报告
   * @param {any} [runtime] 宿主透传的调用方上下文（决定 actor）
   */
  async function report(raw, runtime) {
    // 校验失败抛 ReportValidationError：这里之后才允许产生任何写入
    const { report: normalized } = validateReport(raw, { maxBytes: cfg.maxReportBytes })

    const actor = childActor(runtime)
    const detail = await requireCard(normalized.taskId)
    const card = detail.card

    // 门禁（T11）：卡须在本会话名下，且状态属于 assigned / doing / review。
    // 必须在**任何写入之前**判 —— 被拒的报告不能在看板上留下半条记录。
    assertReportAllowed({ card, sessionId: actor.sessionId, taskId: normalized.taskId })
    const isFinal = raw !== null && typeof raw === 'object' && /** @type {any} */ (raw).final === true

    const entry = typeof ledger.latest === 'function' ? await ledger.latest(normalized.taskId) : null
    /** @type {any[]} */
    let violations
    if (entry) {
      violations = bindReportToLedger({ ledger, entry, report: normalized }).violations
    } else {
      violations = [
        {
          kind: 'ledger',
          text: normalized.taskId,
          reason:
            '台账里没有 ' + normalized.taskId + ' 的条目：无法逐条核对 constraints/acceptance/boundaries/forbidden',
        },
      ]
    }

    // 违规也要在板上留痕，否则 master 回收时看不到（tag 是记录里唯一能带附加信息的自由字段）
    const violationTags = violations.map(
      (violation) =>
        VIOLATION_TAG_PREFIX + String(violation && violation.kind ? violation.kind : 'unknown') + ':' +
        oneLine(violation && (violation.text ?? violation.reason)),
    )
    const ledgerVersion = entry && Number.isSafeInteger(entry.version) ? entry.version : 0

    /** @type {string[]} */
    const recordIds = []

    // 1 条 finding：body = summary
    const finding = await board.appendRecord({
      cardId: card.id,
      kind: 'finding',
      title: 'finding · ' + normalized.taskId + ' · 台账v' + ledgerVersion,
      body: normalized.summary,
      refs: [normalized.taskId],
      tags: ['report', ...violationTags],
      actor,
    })
    recordIds.push(finding.id)

    // 每条 evidence → 1 条 source：refs = url 或 path，body = quote
    for (const item of normalized.evidence) {
      const ref = item.url ?? item.path
      const source = await board.appendRecord({
        cardId: card.id,
        kind: 'source',
        title: ref,
        body: item.quote,
        refs: [ref],
        tags: ['evidence'],
        actor,
      })
      recordIds.push(source.id)
    }

    // 每个 artifact → 1 条 artifact
    for (const item of normalized.artifacts) {
      /** @type {{path: string, bytes?: number, sha256?: string}} */
      const artifact = { path: item.path }
      if (item.bytes !== undefined) artifact.bytes = item.bytes
      if (item.sha256 !== undefined) artifact.sha256 = item.sha256
      const record = await board.appendRecord({
        cardId: card.id,
        kind: 'artifact',
        title: item.path,
        body: '',
        refs: [item.path],
        artifact,
        tags: ['report'],
        actor,
      })
      recordIds.push(record.id)
    }

    // open_questions 也要进板：它们不进报告摘要，却是 master 唯一能看到「哪里卡住」的渠道
    for (const question of normalized.open_questions) {
      const record = await board.appendRecord({
        cardId: card.id,
        kind: 'open_question',
        title: 'open_question · ' + normalized.taskId,
        body: question,
        refs: [normalized.taskId],
        tags: ['report'],
        actor,
      })
      recordIds.push(record.id)
    }

    // final:true 才把卡推到 review（等 master 验收）；增量报告不动状态
    /** @type {string} */
    let status = card.status
    if (isFinal && card.status !== 'review') {
      const moved = await board.updateCard({
        cardId: card.id,
        rev: card.rev,
        status: 'review',
        actor,
        reason: 'master_report(final:true)',
      })
      status = moved.card.status
    }

    return {
      cardId: card.id,
      recordIds,
      violations,
      ok: violations.length === 0,
      status,
      final: isFinal,
    }
  }

  // -------------------------------------------------------------------------
  // 3. master_collect
  // -------------------------------------------------------------------------

  /**
   * 从卡与记录拼出「每路的结果」：状态、认领者、优先级、摘要、证据、产物、待答问题、违规。
   * @param {any} card
   * @param {any[]} records
   * @returns {any}
   */
  function summarizeCard(card, records) {
    /** @type {any[]} */
    const findings = []
    /** @type {any[]} */
    const evidence = []
    const artifacts = []
    const open_questions = []
    const violations = []
    for (const record of records) {
      if (record.kind === 'finding') {
        findings.push(record.body ?? '')
        for (const tag of record.tags ?? []) {
          if (typeof tag !== 'string' || !tag.startsWith(VIOLATION_TAG_PREFIX)) continue
          const rest = tag.slice(VIOLATION_TAG_PREFIX.length)
          const colon = rest.indexOf(':')
          violations.push(colon === -1
            ? { kind: rest, text: '' }
            : { kind: rest.slice(0, colon), text: rest.slice(colon + 1) })
        }
      } else if (record.kind === 'source') {
        const ref = (record.refs ?? [])[0]
        /** @type {{url?: string, path?: string, quote: string}} */
        const item = { quote: record.body ?? '' }
        if (typeof ref === 'string' && ref !== '') {
          if (isHttpUrl(ref)) item.url = ref
          else item.path = ref
        }
        evidence.push(item)
      } else if (record.kind === 'artifact') {
        artifacts.push(record.artifact ?? { path: (record.refs ?? [])[0] ?? '' })
      } else if (record.kind === 'open_question') {
        open_questions.push(record.body ?? '')
      }
    }
    // 摘要取**最新**一条 finding（增量报告时后写的覆盖前面的）
    const summary = findings.length === 0 ? '' : findings[findings.length - 1]
    return {
      cardId: card.id,
      taskId: card.id,
      label: card.title,
      status: card.status,
      priority: card.priority,
      rev: card.rev,
      assignee: card.assignee,
      childSessionId: card.childSessionId ?? null,
      summary,
      findings,
      evidence,
      artifacts,
      open_questions,
      violations,
      updatedAt: card.updatedAt,
    }
  }

  /**
   * 回收子对话结果：按卡分组（看板是唯一事实来源），返回每张卡的状态/认领者/摘要/违规/证据。
   * names 可只取点名的几路（卡号或标签），未回报的进 missing。
   *
   * @param {{names?: string[] | string, waitMs?: number, status?: string|string[]}} [input]
   */
  async function collect(input = {}) {
    /** @type {string[]} */
    const names = (() => {
      const raw = input?.names
      if (raw === undefined || raw === null) return []
      const list = Array.isArray(raw) ? raw : [raw]
      return list.map((item) => String(item).trim()).filter((item) => item !== '')
    })()
    const waitMs = Number.isSafeInteger(input?.waitMs) && input.waitMs > 0 ? input.waitMs : 0
    const deadline = now() + waitMs
    // now() 在测试里可能是常量：再加一道轮次上限，保证 waitMs 分支不会死循环
    const maxAttempts = Math.max(1, Math.ceil(waitMs / POLL_INTERVAL_MS) + 1)

    /** @type {any[]} */
    let cards = []
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      cards = (await board.listCards({ limit: cfg.maxCards })) ?? []
      if (names.length === 0) break
      const present = new Set(cards.flatMap((card) => [card.id, card.title]))
      if (names.every((name) => present.has(name))) break
      if (attempt + 1 >= maxAttempts || now() >= deadline) break
      await delay(POLL_INTERVAL_MS)
    }

    if (names.length > 0) {
      cards = cards.filter((card) => names.includes(card.id) || names.includes(card.title))
    }
    cards = [...cards].sort((left, right) => cardOrder(left.id) - cardOrder(right.id))

    /** @type {any[]} */
    const children = []
    /** @type {any[]} */
    const allSources = []
    for (const card of cards) {
      const detail = await board.getCard(card.id)
      const summary = summarizeCard(detail.card, detail.records)
      children.push(summary)
      const sources = detail.records.filter((record) => record.kind === 'source')
      allSources.push(...sources)
    }

    const present = new Set(children.flatMap((child) => [child.cardId, child.label]))
    return {
      children,
      missing: names.filter((name) => !present.has(name)),
      sources: aggregateSources(allSources),
    }
  }

  // -------------------------------------------------------------------------
  // 4. master_board（看板读写入口）
  // -------------------------------------------------------------------------

  /**
   * 判一次看板写操作是谁发起的。
   * 认领的语义是「子对话把自己写进 assignee」，所以默认按**调用方**身份；
   * master 显式传 asMaster=true 时才用 master 身份（代派/代填/解除阻塞场景）。
   *
   * @param {any} runtime 宿主透传的调用方上下文
   * @param {any} input 工具参数
   * @returns {any}
   */
  function requesterOf(runtime, input) {
    if (input && input.asMaster === true) return masterActor
    return childActor(runtime)
  }

  /**
   * 看板操作：
   * - op=query：卡摘要视图（可按 status/assignee/priority 过滤）
   * - op=get：单卡明细（卡 + 它的 records）
   * - op=head：看板头（卡数/记录数/revision）
   * - op=records：证据流查询
   * - op=create：master 手工建卡
   *
   * @param {any} [input]
   */
  async function boardTool(input = {}, runtime) {
    const op = input?.op
    // 特权 op 只有 master 会话能做：子对话拿到 master_board 也只能认领/开工/阻塞自己名下的卡。
    // 这一条必须在任何写之前判，否则子对话可以给自己验收。
    const callerId = resolveCaller(runtime, { sessionId: rootId, name: 'master' }).sessionId
    const callerIsMaster = callerId === rootId
    if (MASTER_ONLY_OPS.includes(op) && !callerIsMaster) {
      throw new ToolsError('op=' + op + ' 只有 master 会话能调（当前调用方 ' + callerId + '）：子对话只管自己名下的卡')
    }
    if (input?.asMaster === true && !callerIsMaster) {
      throw new ToolsError('只有 master 会话能用 asMaster：子对话不能借用 master 身份')
    }
    if (op === 'head') return { head: await board.head() }
    if (op === 'query') {
      /** @type {any} */
      const filter = {}
      if (input.status !== undefined && input.status !== null) filter.status = input.status
      if (input.assignee !== undefined && input.assignee !== null) filter.assignee = String(input.assignee)
      if (input.priority !== undefined && input.priority !== null) filter.priority = String(input.priority)
      filter.limit = Number.isSafeInteger(input.limit) && input.limit > 0 ? input.limit : cfg.maxCards
      return { cards: await board.listCards(filter) }
    }
    if (op === 'get') {
      const cardId = requireTaskId(input.cardId)
      const detail = await board.getCard(cardId)
      return { card: detail.card, records: detail.records }
    }
    if (op === 'records') {
      /** @type {any} */
      const filter = {
        sinceSeq: Number.isSafeInteger(input.sinceSeq) && input.sinceSeq > 0 ? input.sinceSeq : 0,
        limit: Number.isSafeInteger(input.limit) && input.limit > 0 ? input.limit : cfg.boardMaxEntries,
      }
      if (input.cardId !== undefined && input.cardId !== null) filter.cardId = requireTaskId(input.cardId)
      if (input.kind !== undefined && input.kind !== null) filter.kind = String(input.kind)
      if (input.tag !== undefined && input.tag !== null) filter.tag = String(input.tag)
      return { records: await board.queryRecords(filter) }
    }
    if (op === 'claim' || op === 'doing' || op === 'block' || op === 'reopen') {
      const cardId = requireTaskId(input.cardId)
      const detail = await board.getCard(cardId)
      // 认领/开工/阻塞：子对话用自己的身份；master 用 master 身份（可代填、可解阻塞）
      const actor = op === 'reopen' ? masterActor : requesterOf(runtime, input)
      /** @type {Record<string, string>} */
      const target = { claim: 'assigned', doing: 'doing', block: 'blocked', reopen: 'todo' }
      const moved = await board.updateCard({
        cardId,
        rev: Number.isSafeInteger(input.rev) ? input.rev : detail.card.rev,
        status: target[op],
        actor,
        ...(typeof input.reason === 'string' ? { reason: input.reason } : {}),
      })
      return { card: moved.card, record: moved.record }
    }
    if (op === 'accept') {
      const cardId = requireTaskId(input.cardId)
      const detail = await board.getCard(cardId)
      const verdict = String(input.verdict ?? '')
      if (!ACCEPT_VERDICTS.includes(verdict)) {
        throw new ToolsError('op=accept 需要 verdict：' + ACCEPT_VERDICTS.join(' / ') + '，实际收到 ' + JSON.stringify(input.verdict))
      }
      const note = typeof input.reason === 'string' ? input.reason.trim() : ''
      const rev = Number.isSafeInteger(input.rev) ? input.rev : detail.card.rev

      if (verdict === 'accept') {
        // 先验收经验再落 done：缺经验就报错，卡绝不能被悄悄结案（T12 验收第 1 条）
        const raw = input.experience
        const explicitNone = input.experienceNone === true
        if (raw === undefined || raw === null) {
          if (!explicitNone) {
            throw new ToolsError(
              'accept 必须带 experience（{ title, lesson, root_cause?, fix?, tags?, scope? }）' +
                '，或显式传 experienceNone:true 声明本次无经验；不允许静默跳过',
            )
          }
        } else if (explicitNone) {
          throw new ToolsError('experience 与 experienceNone 不能同时给：要么写一条经验，要么显式声明无经验')
        }
        /** @type {any} */
        let saved = null
        if (raw !== undefined && raw !== null) {
          if (typeof raw !== 'object' || Array.isArray(raw)) throw new ToolsError('experience 必须是对象')
          if (experience === null || typeof experience.save !== 'function') {
            throw new ToolsError('验收写经验需要经验库（宿主未注入 experience）：先检查插件接线')
          }
          saved = await experience.save({ ...raw, sourceCardId: cardId })
        }
        const moved = await board.updateCard({
          cardId,
          rev,
          status: 'done',
          actor: masterActor,
          reason: note === '' ? '验收通过' : note,
        })
        try {
          await board.appendRecord({
            cardId,
            kind: 'decision',
            title: explicitNone ? '验收通过 · 显式无经验' : '验收通过 · 经验：' + String(saved?.entry?.title ?? ''),
            body: note,
            tags: explicitNone ? ['accept', 'no-experience'] : ['accept', 'experience'],
            actor: masterActor,
          })
        } catch {
          // 审计写失败不该否认已经完成的验收；卡状态已经落盘
        }
        return { verdict, card: moved.card, experience: saved }
      }

      /** @type {Record<string, {status: string, label: string}>} */
      const targets = {
        rework: { status: 'doing', label: '返工' },
        abort: { status: 'todo', label: '作废重派' },
      }
      const target = targets[verdict]
      const moved = await board.updateCard({
        cardId,
        rev,
        status: target.status,
        // abort 是「作废重派」：摘掉认领者，卡才能真正回到 todo 被别人认领；
        // rework 是同一子对话续做，保留 assignee。
        ...(verdict === 'abort' ? { assignee: null } : {}),
        actor: masterActor,
        reason: note === '' ? target.label : target.label + '：' + note,
      })
      return { verdict, card: moved.card, note }
    }
    if (op === 'create') {
      const title = requireText(input.title, 'title')
      const priority = input.priority === undefined ? DEFAULT_PRIORITY : String(input.priority)
      if (!PRIORITIES.includes(priority)) {
        throw new ToolsError('priority 只能是 ' + PRIORITIES.join(' / ') + '，实际收到 ' + JSON.stringify(input.priority))
      }
      const card = await board.createCard({ title, body: input.body, priority, actor: masterActor })
      return { card }
    }
    throw new ToolsError(
      'master_board 不支持的 op：' + JSON.stringify(op) + '（可选 query / get / head / records / create）',
    )
  }

  // -------------------------------------------------------------------------
  // 5. master_digest
  // -------------------------------------------------------------------------

  /**
   * 把长文本压成「落盘 + 摘要指针」：超过预算才落盘，文件名用内容 sha256，天然去重。
   *
   * @param {{text?: string, path?: string, budgetBytes?: number}} [input]
   */
  async function digest(input = {}) {
    const budget = (() => {
      const raw = input?.budgetBytes
      if (raw === undefined || raw === null) return cfg.digestBudgetBytes
      if (!Number.isSafeInteger(raw) || raw <= 0) {
        throw new ToolsError('budgetBytes 必须是正整数（字节），实际收到 ' + JSON.stringify(raw))
      }
      return raw
    })()

    /** @type {string | null} */
    let content = null
    if (typeof input?.text === 'string' && input.text !== '') {
      content = input.text
    } else if (typeof input?.path === 'string' && input.path.trim() !== '') {
      const filePath = input.path.trim()
      try {
        content = await readFile(filePath, 'utf8')
      } catch (error) {
        throw new ToolsError('master_digest 读不到 path：' + filePath + '（' + String((error && error.message) || error) + '）')
      }
    }
    if (content === null) {
      throw new ToolsError('master_digest 需要 text 或 path 之一（都不能为空）')
    }

    const bytes = Buffer.byteLength(content, 'utf8')
    const sha256 = createHash('sha256').update(content, 'utf8').digest('hex')
    if (bytes <= budget) {
      return { locator: null, sha256, bytes, summary: content, truncated: false }
    }

    const dir = artifactsDir(cfg, rootId)
    await mkdir(dir, { recursive: true })
    const locator = join(dir, sha256 + '.md')
    await writeFile(locator, content, 'utf8')
    const keep = Math.max(1, Math.floor(budget / 4))
    return { locator, sha256, bytes, summary: content.slice(0, keep), truncated: true }
  }

  // -------------------------------------------------------------------------
  // 6. master_experience（经验沉淀：save / query / list）
  // -------------------------------------------------------------------------

  /**
   * 经验库操作。只有 master 用它（子对话的白名单里没有这个工具）；
   * 正常路径是验收时由 op=accept 顺手写入，这里给查询与手工补写用。
   *
   * @param {{op?: 'save'|'query'|'list', title?: string, lesson?: string, root_cause?: string,
   *   fix?: string, tags?: string[], scope?: string, sourceCardId?: string, tag?: string,
   *   q?: string, limit?: number, offset?: number}} [input]
   */
  async function experienceTool(input = {}) {
    if (experience === null || typeof experience.save !== 'function') {
      throw new ToolsError('经验库未接线：宿主没有注入 experience（这是接线问题，不是用法问题）')
    }
    const op = input?.op
    if (op === 'save') {
      return experience.save({
        title: input.title,
        lesson: input.lesson,
        root_cause: input.root_cause,
        fix: input.fix,
        tags: input.tags,
        scope: input.scope,
        sourceCardId: input.sourceCardId,
      })
    }
    if (op === 'query') {
      /** @type {any} */
      const filter = {}
      if (input.tag !== undefined && input.tag !== null) filter.tag = String(input.tag)
      if (input.scope !== undefined && input.scope !== null) filter.scope = String(input.scope)
      if (input.q !== undefined && input.q !== null) filter.q = String(input.q)
      return { entries: await experience.query(filter) }
    }
    if (op === 'list') {
      return experience.list({
        ...(Number.isSafeInteger(input.limit) ? { limit: input.limit } : {}),
        ...(Number.isSafeInteger(input.offset) ? { offset: input.offset } : {}),
      })
    }
    throw new ToolsError('master_experience 不支持的 op：' + JSON.stringify(op) + '（可选 save / query / list）')
  }

  // -------------------------------------------------------------------------
  // definitions：ctx.tools.register 可接受的普通对象形状
  // -------------------------------------------------------------------------

  /**
   * 可空字段：宿主的 schema 子集里没有 type 数组，用 oneOf 表达 object|null。
   * 真机教训：卡未认领时 assignee 是 null、未派发时 childSessionId 是 null，
   * 声明成 {type:'object'} 会让宿主的输出校验直接拒掉整次调用。
   */
  const NULLABLE_OBJECT = { oneOf: [{ type: 'object' }, { type: 'null' }] }
  const NULLABLE_STRING = { oneOf: [{ type: 'string' }, { type: 'null' }] }
  /** 未指定 tools 白名单时 childAllowList 返回 null（表示不限制）。 */
  const NULLABLE_STRING_ARRAY = { oneOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }] }

  /** 卡摘要的 output schema 片段（多个工具复用） */
  const CARD_SCHEMA = {
    type: 'object',
    properties: {
      id: { type: 'string' },
      rev: { type: 'integer' },
      status: { type: 'string' },
      priority: { type: 'string' },
      title: { type: 'string' },
      assignee: NULLABLE_OBJECT,
      childSessionId: NULLABLE_STRING,
    },
  }

  /** @type {object[]} */
  /**
   * 宿主契约（dsh-tools/src/contracts.ts）：ToolOutputDefinition.render 必须返回
   * **ContentBlock[]**，不是字符串。真机上返回字符串会让宿主的 content.some(...) 崩，
   * 表现为工具调用直接报 `Error: content.some is not a function`（已实测）。
   *
   * @param {unknown} value
   * @returns {{type: 'text', text: string}[]}
   */
  function textBlock(value) {
    return [{ type: 'text', text: String(value) }]
  }

  const definitions = [
    {
      name: 'master_assign',
      description:
        '下派一路任务：先在看板建一张 todo 卡（卡号即 taskId），再把 brief 的四组约束写进约束台账、按台账渲染交接契约 prompt，最后开子会话。子对话开工第一件事是认领这张卡。spawn 失败会丢弃刚建的卡（不污染看板），可用同一个 taskId 重试。可选 tools 参数给子对话限定可见工具（自动补 master_report/master_board）。',
      parameters: {
        type: 'object',
        properties: {
          label: { type: 'string', description: '子对话的展示名，也是看板卡的标题' },
          name: { type: 'string', description: '可选：子会话短名（小写字母/数字/连字符）' },
          taskId: { type: 'string', description: '可选：复用已有卡号（下派失败后按返回的 taskId 重试）' },
          priority: { type: 'string', enum: [...PRIORITIES], description: '可选：卡片的 P 级，缺省 P2' },
          tools: {
            type: 'array',
            items: { type: 'string' },
            description:
              '可选：子对话可见工具白名单（如 ["read","write","pwsh"]），会自动补上 master_report 与 master_board；省略表示不限制',
          },
          brief: {
            type: 'object',
            properties: {
              goal: { type: 'string', description: '一句话目标（必填，也是卡标题）' },
              inputs: { description: '已知输入：字符串，或字符串/对象数组' },
              constraints: { type: 'array', description: '硬约束（进台账，逐条核对）', items: {} },
              acceptance: { type: 'array', description: '验收标准（全部满足才算完成）', items: {} },
              boundaries: { type: 'array', description: '产物路径前缀白名单', items: {} },
              forbidden: { type: 'array', description: '禁止项（不得出现在 summary/findings）', items: {} },
              budget: { description: '报告字节预算：正整数，或 { maxReportBytes: 正整数 }' },
            },
            required: ['goal'],
          },
        },
        required: ['label', 'brief'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            taskId: { type: 'string' },
            cardId: { type: 'string' },
            status: { type: 'string' },
            priority: { type: 'string' },
            promptBytes: { type: 'integer' },
            childSessionId: NULLABLE_STRING,
            child: { type: 'object', description: '宿主 spawnActivation 的返回句柄' },
            tools: NULLABLE_STRING_ARRAY,
            ledgerVersion: { type: 'integer' },
            error: { type: 'object', properties: { name: { type: 'string' }, message: { type: 'string' } } },
          },
          required: ['taskId'],
        },
        render(args, value) {
          if (value && value.ok === false) {
            const message = value.error && value.error.message ? value.error.message : '未知错误'
            return textBlock(
              '下派失败：' + message + '；taskId=' + String(value.taskId) +
              '（台账 v' + String(value.ledgerVersion) + '，可用同一个 taskId 重试；卡已回滚）',
            )
          }
          return textBlock(
            '已下派 ' + String(value && value.taskId) + '：卡 ' + String(value && value.cardId) +
            '（' + String(value && value.status) + '，' + String(value && value.priority) + '），交接契约 ' +
            String((value && value.promptBytes) || 0) + ' 字节，子会话 ' +
            String((value && value.childSessionId) || '（宿主未返回句柄）'),
          )
        },
      },
      execute: (args, runtime) => assign(args, runtime),
    },
    {
      name: 'master_dispatch',
      description:
        '批量派发：一次派 N 路子对话，整批只弹一次审批（审批在工具层 tools/pre-execute，被拒则一张卡都不建、一个子会话都不开）。预检在任何写入之前：配额（maxChildren）、每路 brief 齐备（constraints 或 acceptance 至少一条）、显式 taskId 必须已在板上。任一路 spawn 失败会回滚本批新建的卡，已启动的子会话如实回报。',
      parameters: {
        type: 'object',
        properties: {
          briefs: {
            type: 'array',
            description: '每路一份：{ label, name?, taskId?, priority?, tools?, brief }',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string' },
                name: { type: 'string' },
                taskId: { type: 'string', description: '可选：用板上已有的卡（必须存在）' },
                priority: { type: 'string', enum: [...PRIORITIES] },
                tools: { type: 'array', items: { type: 'string' } },
                brief: {
                  type: 'object',
                  properties: {
                    goal: { type: 'string' },
                    inputs: {},
                    constraints: { type: 'array', items: {} },
                    acceptance: { type: 'array', items: {} },
                    boundaries: { type: 'array', items: {} },
                    forbidden: { type: 'array', items: {} },
                    budget: {},
                  },
                  required: ['goal'],
                },
              },
              required: ['label', 'brief'],
            },
          },
        },
        required: ['briefs'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            dispatched: { type: 'integer' },
            failedAt: { type: 'integer' },
            started: { type: 'integer' },
            rolledBack: { type: 'array', items: { type: 'string' } },
            routes: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  taskId: { type: 'string' },
                  label: { type: 'string' },
                  priority: { type: 'string' },
                  childSessionId: NULLABLE_STRING,
                  strategy: { type: 'string' },
                  costHint: { type: 'string' },
                  tools: NULLABLE_STRING_ARRAY,
                },
              },
            },
            error: { type: 'object', properties: { name: { type: 'string' }, message: { type: 'string' } } },
          },
          required: ['ok'],
        },
        render(args, value) {
          if (value && value.ok === false) {
            const rolled = Array.isArray(value.rolledBack) ? value.rolledBack : []
            return textBlock(
              '批量派发失败（第 ' + String(value.failedAt) + ' 路）：' +
              String((value.error && value.error.message) || '未知错误') +
              '；已回滚卡 ' + (rolled.length === 0 ? '（无）' : rolled.join('、')) +
              '；已启动 ' + String(value.started) + ' 路（不要重复派发）',
            )
          }
          const routes = Array.isArray(value && value.routes) ? value.routes : []
          return textBlock(
            '已批量派发 ' + routes.length + ' 路：' +
            routes.map((route) => String(route.taskId) + '(' + String(route.priority) + ')').join('、'),
          )
        },
      },
      execute: (args, runtime) => dispatchTool(args, runtime),
    },
    {
      name: 'master_report',
      description:
        '子对话回传结构化报告（结束前必须调用）。校验失败会直接报错、一个字节都不写；校验通过才把 finding/source/artifact/open_question 作为记录挂到本卡，并按约束台账逐条核对：有 violations 仍写盘，但 ok=false 且逐条列出原因。final=true 时才把卡推到 review 等 master 验收；增量报告（final 省略或 false）不改卡状态。',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: '交接契约里的卡号，必须一致' },
          summary: { type: 'string', description: '非空蒸馏摘要，超 maxReportBytes 字节即整份拒收' },
          findings: {
            type: 'array',
            description: '至少 1 条发现',
            items: {
              type: 'object',
              properties: { text: { type: 'string' }, refs: { type: 'array', items: { type: 'string' } } },
              required: ['text'],
            },
          },
          evidence: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                url: { type: 'string', description: 'http/https' },
                path: { type: 'string' },
                quote: { type: 'string', description: '原文关键句（必填）' },
              },
              required: ['quote'],
            },
          },
          open_questions: { type: 'array', items: { type: 'string' } },
          artifacts: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                bytes: { type: 'integer' },
                sha256: { type: 'string' },
              },
              required: ['path'],
            },
          },
          confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
          schemaVersion: { type: 'integer', description: '当前只支持 1' },
          final: { type: 'boolean', description: 'true 才把卡推到 review 等验收；增量报告省略或 false（不改卡状态）' },
        },
        required: ['taskId', 'summary', 'findings', 'confidence'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            cardId: { type: 'string' },
            recordIds: { type: 'array', items: { type: 'string' } },
            violations: {
              type: 'array',
              items: {
                type: 'object',
                properties: { kind: { type: 'string' }, text: { type: 'string' }, reason: { type: 'string' } },
              },
            },
            ok: { type: 'boolean' },
            status: { type: 'string' },
          },
          required: ['cardId', 'recordIds', 'violations', 'ok'],
        },
        render(args, value) {
          const count = Array.isArray(value && value.recordIds) ? value.recordIds.length : 0
          const tail = value && value.final ? '，卡已推到 review 等验收' : ''
          if (value && value.ok === true) {
            return textBlock('已写入卡 ' + String(value.cardId) + ' 的 ' + count + ' 条记录；台账逐条校验通过' + tail)
          }
          const violations = Array.isArray(value && value.violations) ? value.violations : []
          const first = violations[0]
          const detail = first ? '，首条：' + String(first.kind) + ' ' + String(first.reason ?? first.text ?? '') : ''
          return textBlock('已写入卡 ' + String(value && value.cardId) + ' 的 ' + count + ' 条记录；台账违规 ' + violations.length + ' 处' + detail)
        },
      },
      execute: (args, runtime) => report(args, runtime),
    },
    {
      name: 'master_collect',
      description:
        '回收子对话结果：按看板卡分组，返回每张卡的状态、认领者、优先级、摘要、发现、证据、产物、待答问题与台账违规；names 可只取点名的几路（卡号或标题），未回报的进 missing。',
      parameters: {
        type: 'object',
        properties: {
          names: { type: 'array', items: { type: 'string' }, description: '只回收这些卡号/标题' },
          waitMs: { type: 'integer', description: '最多等多久（毫秒），0 表示立即返回当前看板' },
        },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            children: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  cardId: { type: 'string' },
                  taskId: { type: 'string' },
                  label: { type: 'string' },
                  status: { type: 'string' },
                  priority: { type: 'string' },
                  rev: { type: 'integer' },
                  assignee: NULLABLE_OBJECT,
                  childSessionId: NULLABLE_STRING,
                  summary: { type: 'string' },
                  findings: { type: 'array', items: { type: 'string' } },
                  evidence: { type: 'array', items: { type: 'object' } },
                  artifacts: { type: 'array', items: { type: 'object' } },
                  open_questions: { type: 'array', items: { type: 'string' } },
                  violations: { type: 'array', items: { type: 'object' } },
                  updatedAt: { type: 'integer' },
                },
              },
            },
            missing: { type: 'array', items: { type: 'string' } },
            sources: { type: 'object', description: '来源聚合（lib/sources.js）' },
          },
          required: ['children', 'missing'],
        },
        render(args, value) {
          const children = Array.isArray(value && value.children) ? value.children : []
          const missing = Array.isArray(value && value.missing) ? value.missing : []
          const names = children.map((child) => String(child && child.cardId) + '(' + String(child && child.status) + ')').join('、')
          return textBlock(
            '已回收 ' + children.length + ' 张卡' + (names ? '：' + names : '') +
            (missing.length > 0 ? '；未回报：' + missing.join('、') : ''),
          )
        },
      },
      execute: (args, runtime) => collect(args, runtime),
    },
    {
      name: 'master_board',
      description:
        '看板的读写入口（看板是唯一事实来源）：op=query 返回卡摘要视图（可按 status/assignee/priority 过滤）；op=get 返回单卡明细（卡 + 它的证据流）；op=head 返回卡数与记录数；op=records 查证据流；op=create 由 master 手工建卡。',
      parameters: {
        type: 'object',
        properties: {
          op: {
            type: 'string',
            enum: ['query', 'get', 'head', 'records', 'create', 'claim', 'doing', 'block', 'reopen', 'accept'],
            description:
              'query/get/head/records/create 是读与建卡；claim(认领 todo→assigned)、doing(开工 assigned→doing)、' +
              'block(阻塞)、reopen(由 master 解除阻塞回 todo)、accept(T12 验收)',
          },
          cardId: { type: 'string', description: 'op=get/records/claim/doing/block/reopen/accept 用：卡号 t1..tN' },
          rev: { type: 'integer', description: '可选：显式 CAS 版本（省略则用读到的当前 rev）' },
          reason: { type: 'string', description: 'op=block/reopen/accept 用：原因记进审计' },
          asMaster: { type: 'boolean', description: 'op=claim/doing/block 用：以 master 身份操作（代填/代派）' },
          status: { type: 'string', description: 'op=query 用：todo/assigned/doing/review/done/blocked 之一或数组' },
          assignee: { type: 'string', description: 'op=query 用：按认领者 sessionId 过滤' },
          priority: { type: 'string', enum: [...PRIORITIES], description: 'op=query/create 用：P 级' },
          kind: { type: 'string', description: 'op=records 用：记录类型' },
          tag: { type: 'string', description: 'op=records 用：按 tag 精确过滤' },
          sinceSeq: { type: 'integer', description: 'op=records 用：只取 seq 大于它的记录' },
          limit: { type: 'integer', description: '最多返回多少条' },
          title: { type: 'string', description: 'op=create 用：卡标题' },
          body: { type: 'string', description: 'op=create 用：卡正文' },
          verdict: {
            type: 'string',
            enum: [...ACCEPT_VERDICTS],
            description: 'op=accept 用：accept 置 done 并写经验 / rework 回 doing 附 note / abort 回 todo',
          },
          experience: {
            type: 'object',
            description: 'op=accept 用：本次沉淀的经验（与 experienceNone 二选一）',
            properties: {
              title: { type: 'string' },
              lesson: { type: 'string' },
              root_cause: { type: 'string' },
              fix: { type: 'string' },
              tags: { type: 'array', items: { type: 'string' } },
              scope: { type: 'string', enum: ['project', 'global'] },
            },
            required: ['title', 'lesson'],
          },
          experienceNone: {
            type: 'boolean',
            description: 'op=accept 用：显式声明本次没有可复用经验（与 experience 二选一）',
          },
        },
        required: ['op'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            cards: { type: 'array', items: CARD_SCHEMA },
            card: CARD_SCHEMA,
            records: { type: 'array', items: { type: 'object' } },
            head: { type: 'object' },
          },
        },
        render(args, value) {
          if (value && Array.isArray(value.cards)) return textBlock('看板返回 ' + value.cards.length + ' 张卡')
          if (value && value.card) return textBlock('卡 ' + String(value.card.id) + '（' + String(value.card.status) + '，rev ' + String(value.card.rev) + '）+ ' + String((value.records || []).length) + ' 条记录')
          if (value && value.head) {
            const head = value.head
            return textBlock(
              '看板头：卡 ' + String(head.cards ?? 0) + ' 张、记录 ' + String(head.records ?? 0) + ' 条、revision ' +
              String(head.revision ?? 0) + '、退役卡 ' + String(head.retired ?? 0) + ' 张',
            )
          }
          if (value && Array.isArray(value.records)) return textBlock('证据流返回 ' + value.records.length + ' 条记录')
          return textBlock('看板操作完成')
        },
      },
      execute: (args, runtime) => boardTool(args, runtime),
    },
    {
      name: 'master_digest',
      description:
        '把超长文本压成摘要指针：未超预算原样返回；超预算则按内容 sha256 落盘成 artifacts/<sha256>.md，只返回 locator、sha256、字节数与前 budget/4 个字符的摘要。用来避免把全文塞回上下文。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要处理的正文' },
          path: { type: 'string', description: '或者给一个本地文件路径（text 优先）' },
          budgetBytes: { type: 'integer', description: '字节预算，缺省取 config.digestBudgetBytes' },
        },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            locator: NULLABLE_STRING,
            sha256: { type: 'string' },
            bytes: { type: 'integer' },
            summary: { type: 'string' },
            truncated: { type: 'boolean' },
          },
          required: ['sha256', 'bytes', 'summary', 'truncated'],
        },
        render(args, value) {
          const bytes = (value && value.bytes) || 0
          if (value && value.truncated) {
            return textBlock(
              '正文已落盘：' + String((value && value.locator) || '（无路径）') + '（' + bytes + ' 字节，摘要 ' +
              String((value && value.summary) || '').length + ' 字符）',
            )
          }
          return textBlock('正文未超预算，未落盘（' + bytes + ' 字节）')
        },
      },
      execute: (args, runtime) => digest(args, runtime),
    },
    {
      name: 'master_experience',
      description:
        '经验库（本项目自给自足，不依赖任何外部记忆插件）。op=save 写一条经验（title 归一去重，重复则 verified_count+1 并追加来源卡）；op=query 按 tag/scope/关键词检索；op=list 分页列出。默认写项目级 .agent-master/experience.jsonl，scope=global 才写用户级 ~/.dsh/agent-master/；读取时两级合并、项目优先。',
      parameters: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: ['save', 'query', 'list'] },
          title: { type: 'string', description: 'op=save：经验标题（归一去重键）' },
          lesson: { type: 'string', description: 'op=save：一条可复用的教训（必填）' },
          root_cause: { type: 'string', description: 'op=save：根因' },
          fix: { type: 'string', description: 'op=save：修法/正确做法' },
          tags: { type: 'array', items: { type: 'string' }, description: 'op=save：标签' },
          scope: { type: 'string', enum: ['project', 'global'], description: 'op=save：缺省 project' },
          sourceCardId: { type: 'string', description: 'op=save：来源卡号（验收时自动填）' },
          tag: { type: 'string', description: 'op=query：按 tag 过滤' },
          q: { type: 'string', description: 'op=query：标题/教训关键词' },
          limit: { type: 'integer', description: 'op=list/query：每页条数' },
          offset: { type: 'integer', description: 'op=list：偏移' },
        },
        required: ['op'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            action: { type: 'string' },
            entry: { type: 'object' },
            entries: { type: 'array', items: { type: 'object' } },
            items: { type: 'array', items: { type: 'object' } },
            total: { type: 'integer' },
            limit: { type: 'integer' },
            offset: { type: 'integer' },
          },
        },
        render(args, value) {
          if (value && typeof value.action === 'string') {
            const entry = value.entry ?? {}
            return textBlock(
              (value.action === 'created' ? '已记入经验：' : '经验已再确认（verified_count=' +
                String(entry.verified_count) + '）：') + String(entry.title ?? ''),
            )
          }
          if (value && Array.isArray(value.entries)) return textBlock('经验检索到 ' + value.entries.length + ' 条')
          if (value && Array.isArray(value.items)) {
            return textBlock('经验库 ' + value.items.length + '/' + String(value.total) + ' 条（offset ' + String(value.offset) + '）')
          }
          return textBlock('经验库操作完成')
        },
      },
      execute: (args, runtime) => experienceTool(args, runtime),
    },
  ]

  return {
    assign,
    dispatch: dispatchTool,
    collect,
    report,
    boardTool,
    digest,
    experience: experienceTool,
    definitions,
    masterActor,
  }
}
