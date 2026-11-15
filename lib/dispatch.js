/**
 * dsh-agent-master — 派发策略阶梯。
 *
 * 背景（plan §3 决策表）：NeurIPS'26 的协议税 —— 同一套多智能体配置在一处 +14.2pp、
 * 在另一处 −23.6pp，「发得更充分」不等于「更好用」。所以每次下派/回传都要先问
 * 「这次到底该发多少」：发摘要、发原文、不发、换更强的现有子会话、还是只更新黑板。
 *
 * 本模块是**纯函数**：按固定顺序过一遍阶梯，返回策略、中文原因与成本档。
 * 顺序即优先级，测试把它锁死（例：「没有空位」优先于「体积太大」）。
 *
 * 输入（六个字段全部必填，缺失/类型不对一律抛 DispatchError —— 派发决策不能靠猜）：
 * { payloadBytes, budgetBytes, childCapacity, sameModelAvailability,
 *   priorAttemptFailed, sharedStateUpdated }
 *
 * @module dsh-agent-master/dispatch
 */

/** 五档策略（顺序固定，与决策阶梯一致）。 */
export const STRATEGIES = Object.freeze(['summary', 'original', 'skip', 'escalate', 'board-only'])

/** 每档的传输成本：跳过的两档不传内容所以是 low。 */
export const COST_HINTS = Object.freeze({
  summary: 'medium',
  original: 'high',
  escalate: 'high',
  skip: 'low',
  'board-only': 'low',
})

/** 派发决策错误（输入不合法）。 */
export class DispatchError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message)
    this.name = 'DispatchError'
  }
}

/** 布尔字段（三个开关都必须显式给出） */
const BOOLEAN_FIELDS = Object.freeze(['sameModelAvailability', 'priorAttemptFailed', 'sharedStateUpdated'])

/** 值类型的简短描述（拼进错误文案） */
function describe(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number' && Number.isNaN(value)) return 'NaN'
  return typeof value
}

/** 展示用的值：字符串加引号，其余直接转文本 */
function show(value) {
  return typeof value === 'string' ? JSON.stringify(value) : String(value)
}

/** 字节数的展示文本（整数原样，小数留两位） */
function bytes(value) {
  const rounded = Number.isInteger(value) ? value : Math.round(value * 100) / 100
  return rounded + 'B'
}

/**
 * 校验并取出六个字段；一次列全部问题，而不是修一个报一个。
 * 未知的多余字段忽略（前向兼容）。
 *
 * @param {unknown} input
 * @returns {{ payloadBytes: number, budgetBytes: number, childCapacity: number, sameModelAvailability: boolean, priorAttemptFailed: boolean, sharedStateUpdated: boolean }}
 * @throws {DispatchError}
 */
function validateInput(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new DispatchError(
      'chooseDispatch 需要对象输入（payloadBytes/budgetBytes/childCapacity/' +
      BOOLEAN_FIELDS.join('/') + '），实际收到 ' + describe(input),
    )
  }
  const raw = /** @type {any} */ (input)
  /** @type {string[]} */
  const errors = []

  const { payloadBytes, budgetBytes, childCapacity } = raw
  if (typeof payloadBytes !== 'number' || !Number.isFinite(payloadBytes) || payloadBytes < 0) {
    errors.push('payloadBytes 必须是非负有限数字（实际 ' + show(payloadBytes) + '）')
  }
  if (typeof budgetBytes !== 'number' || !Number.isFinite(budgetBytes) || budgetBytes <= 0) {
    errors.push('budgetBytes 必须是正有限数字，不能用 0（实际 ' + show(budgetBytes) + '）')
  }
  if (!Number.isSafeInteger(childCapacity) || childCapacity < 0) {
    errors.push('childCapacity 必须是非负安全整数（实际 ' + show(childCapacity) + '）')
  }
  for (const name of BOOLEAN_FIELDS) {
    if (typeof raw[name] !== 'boolean') {
      errors.push(name + ' 必须是布尔值（实际 ' + show(raw[name]) + '）')
    }
  }
  if (errors.length > 0) {
    throw new DispatchError('chooseDispatch 输入不合法：' + errors.join('；'))
  }

  return {
    payloadBytes,
    budgetBytes,
    childCapacity,
    sameModelAvailability: raw.sameModelAvailability,
    priorAttemptFailed: raw.priorAttemptFailed,
    sharedStateUpdated: raw.sharedStateUpdated,
  }
}

/**
 * 组装返回值（字段顺序固定：strategy, reason, costHint）。
 * @param {(typeof STRATEGIES)[number]} strategy
 * @param {string} reason
 */
function decide(strategy, reason) {
  return { strategy, reason, costHint: COST_HINTS[strategy] }
}

/**
 * 按固定五档阶梯选派发策略。
 *
 * 判定顺序即优先级（不要调整）：
 *   1. payloadBytes <= budgetBytes/4            -> summary（本来就不大）
 *   2. payloadBytes <= budgetBytes 且摘要失败过  -> original（直接给原文）
 *   3. childCapacity <= 0                      -> escalate（没空位，换/等）
 *   4. payloadBytes > budgetBytes 且黑板未更新   -> board-only（先更新共享状态）
 *   5. payloadBytes > budgetBytes               -> skip（本次不传，靠黑板）
 *   6. 其余                                    -> summary
 * 因此 childCapacity=0 会先于体积超限命中 escalate，而极小体积会先于容量检查命中 summary。
 *
 * @param {{ payloadBytes: number, budgetBytes: number, childCapacity: number, sameModelAvailability: boolean, priorAttemptFailed: boolean, sharedStateUpdated: boolean }} input
 * @returns {{ strategy: (typeof STRATEGIES)[number], reason: string, costHint: 'low'|'medium'|'high' }}
 * @throws {DispatchError} 字段缺失或类型不对
 */
export function chooseDispatch(input) {
  const { payloadBytes, budgetBytes, childCapacity, sameModelAvailability, priorAttemptFailed, sharedStateUpdated } =
    validateInput(input)
  const shareBudget = budgetBytes / 4

  // 1. 本来就小：直接发摘要
  if (payloadBytes <= shareBudget) {
    return decide('summary', '体积 ' + bytes(payloadBytes) + ' 不超过预算 ' + bytes(budgetBytes) +
      ' 的四分之一（' + bytes(shareBudget) + '），本来就不大，直接发摘要。')
  }

  // 2. 在预算内但摘要已经失败过：改发原文，别二次压缩
  if (payloadBytes <= budgetBytes && priorAttemptFailed) {
    return decide('original', '体积 ' + bytes(payloadBytes) + ' 在预算 ' + bytes(budgetBytes) +
      ' 以内，但摘要已经失败过一次，改发原文，避免二次压缩再丢信息。')
  }

  // 3. 没空位：先换更强的现有子会话或等位（优先级高于体积规则）
  if (childCapacity <= 0) {
    return decide('escalate', '没有空位（childCapacity=0），换更强的现有子会话或等位（同模型可用性：' +
      (sameModelAvailability ? '有' : '无') + '）；容量检查优先于体积规则。')
  }

  // 4. 太大且黑板还没更新：先更新共享状态，本次不发内容
  if (payloadBytes > budgetBytes && !sharedStateUpdated) {
    return decide('board-only', '体积 ' + bytes(payloadBytes) + ' 超出预算 ' + bytes(budgetBytes) +
      ' 且共享状态还没更新，先把结论写进黑板，本次不传内容。')
  }

  // 5. 太大：本次不传，让对方按黑板续读
  if (payloadBytes > budgetBytes) {
    return decide('skip', '体积 ' + bytes(payloadBytes) + ' 超出预算 ' + bytes(budgetBytes) +
      '，本次不传，让对方按黑板续读。')
  }

  // 6. 在预算内、摘要没失败过：发摘要就够
  return decide('summary', '体积 ' + bytes(payloadBytes) + ' 在预算 ' + bytes(budgetBytes) +
    ' 以内、摘要没失败过，发摘要即可。')
}
