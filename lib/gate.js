/**
 * dsh-agent-master — T11：报告门禁（工具层硬拦截）。
 *
 * 规则只有一条，但必须在**任何写入之前**判：
 *   卡须在该会话名下，且状态属于 assigned / doing / review。
 *
 * 为什么是硬门禁而不是提示词：提示词可以被跳过，而「子对话第一件事更新看板」是
 * 整个协作协议的地基 —— 没认领就能交报告，看板就不再是唯一事实来源。
 *
 * 本模块是**纯函数**：不看盘、不写盘、不 import 板，方便单测与复用。
 *
 * @module dsh-agent-master/gate
 */

/** 允许交报告的状态：认领后、开工中、以及已经交过 final 等验收（可补增量）。 */
export const REPORT_ALLOWED_STATUSES = Object.freeze(['assigned', 'doing', 'review'])

/** 状态中文名（错误文案用；与 lib/board.js 的 STATUS_LABELS 同义，但不 import 以保持纯函数）。 */
const STATUS_TEXT = Object.freeze({
  todo: '待认领',
  assigned: '已认领',
  doing: '开工中',
  review: '待验收',
  done: '已完成',
  blocked: '阻塞',
})

/**
 * 门禁拒绝：文案里必须带**下一步动作**，模型才知道该干什么。
 */
export class GateError extends Error {
  /**
   * @param {string} message
   * @param {{cardId?: string, status?: string, action?: string}} [details]
   */
  constructor(message, details = {}) {
    super(message)
    this.name = 'GateError'
    this.cardId = details.cardId ?? null
    this.status = details.status ?? null
    this.action = details.action ?? null
  }
}

/**
 * 断言这张卡现在允许该会话交报告。
 *
 * @param {{
 *   card: {id: string, status: string, assignee: {sessionId: string, name?: string}|null},
 *   sessionId: string,
 *   taskId?: string,
 * }} input
 * @returns {true}
 * @throws {GateError} 不满足门禁
 */
export function assertReportAllowed({ card, sessionId, taskId } = {}) {
  if (!card || typeof card !== 'object') {
    throw new GateError('门禁需要 card：拿不到卡片就无法判断归属与状态', { action: '先 master_board op=get 确认卡号' })
  }
  const cardId = typeof card.id === 'string' ? card.id : String(taskId ?? '')
  const who = typeof sessionId === 'string' ? sessionId : ''

  if (who === '') {
    throw new GateError(
      '无法确定报告来自哪个会话（sessionId 为空）：拒绝在身份不明时写看板',
      { cardId, action: '由宿主透传调用方 sessionId 后重试' },
    )
  }

  // 1. 卡必须已认领
  if (card.assignee === null || card.assignee === undefined) {
    throw new GateError(
      '卡 ' + cardId + ' 还没被认领（状态 ' + card.status + '）：子对话开工第一件事是认领',
      {
        cardId,
        status: card.status,
        action: '先调 master_board op=claim（或 updateCard）把 ' + cardId + ' 从 todo 翻成 assigned，再交报告',
      },
    )
  }

  // 2. 必须在本会话名下（改派后旧会话立刻失去资格）
  if (card.assignee.sessionId !== who) {
    throw new GateError(
      '卡 ' + cardId + ' 挂在 ' + String(card.assignee.name ?? card.assignee.sessionId) +
        ' 名下（' + who + ' 不是认领者）：不能交报告',
      {
        cardId,
        status: card.status,
        action: '若已被改派，等 master 重新派发；不要重复提交别人的任务',
      },
    )
  }

  // 3. 状态必须允许交报告
  if (!REPORT_ALLOWED_STATUSES.includes(card.status)) {
    const text = STATUS_TEXT[card.status] ?? card.status
    throw new GateError(
      '卡 ' + cardId + ' 现在状态是 ' + card.status + '（' + text + '），不接受报告；只接受 ' +
        REPORT_ALLOWED_STATUSES.join(' / '),
      {
        cardId,
        status: card.status,
        action: card.status === 'todo'
          ? '先认领（todo → assigned）再交报告'
          : card.status === 'blocked'
            ? '阻塞卡要先由 master 解除（回 todo）再重新认领'
            : '已完成/结案的卡不再接受报告；需要返工请由 master 用 op=accept(verdict=rework) 拉回 doing',
      },
    )
  }

  return true
}
