/**
 * dsh-agent-master — T12：经验沉淀（ADR-0003，零外部依赖）。
 *
 * 经验 = 验收时二次蒸馏出来的教训。只有 master 在 master_board op=accept 时写；
 * 原报告留在卡的 records 里，这里只存指针（sourceCardId）。
 *
 * 两级存储：
 * - 项目级：<workspace>/.agent-master/experience.jsonl（默认）
 * - 用户级：~/.dsh/agent-master/experience.jsonl（scope=global 才写）
 * 读取时两级合并，**项目级内容优先**（跨项目经验做补充，不覆盖本项目的具体做法）。
 *
 * 文件是 append-only JSONL：去重后的「再确认」不重写既有行，而是追加一条 verify 事件，
 * 读取时折叠成 verified_count 与 sources。这样并发写不会互相踩，历史也可回放。
 *
 * @module dsh-agent-master/experience
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 经验文件名。 */
export const EXPERIENCE_FILE = 'experience.jsonl'

/** 两个作用域。 */
export const EXPERIENCE_SCOPES = Object.freeze(['project', 'global'])

export class ExperienceError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message)
    this.name = 'ExperienceError'
  }
}

/**
 * title 归一：去首尾空白、把连续空白压成一个空格、转小写。
 * 目的只有一个 —— 同一个教训换个大小写/空格写法不该变成两条经验。
 * @param {unknown} title
 * @returns {string}
 */
export function normalizeTitle(title) {
  return String(title ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/**
 * 用户级经验目录：~/.dsh/agent-master（可用 DSH_HOME 覆盖）。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function globalExperienceDir(env = process.env) {
  // 与 lib/config.js 的 dshHome 同序：DSH_HOME 优先，其次 USERPROFILE，最后 homedir()
  const home = (typeof env.DSH_HOME === 'string' && env.DSH_HOME !== '')
    ? env.DSH_HOME
    : (typeof env.USERPROFILE === 'string' && env.USERPROFILE !== '') ? env.USERPROFILE : homedir()
  return join(home, '.dsh', 'agent-master')
}

/** @param {unknown} value @returns {string} */
function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 经验库：一个 store 实例对应一份项目库 + 一份用户库。
 */
export class ExperienceStore {
  /** @type {string} */
  #projectDir
  /** @type {string} */
  #globalDir
  /** @type {() => number} */
  #now
  /** @type {any} */
  #io

  /**
   * @param {{projectDir: string, globalDir?: string, now?: () => number, io?: Record<string, Function>}} options
   */
  constructor({ projectDir, globalDir = globalExperienceDir(), now = () => Date.now(), io = {} } = {}) {
    if (typeof projectDir !== 'string' || projectDir.trim() === '') {
      throw new ExperienceError('ExperienceStore 需要一个非空的 projectDir')
    }
    this.#projectDir = projectDir
    this.#globalDir = globalDir
    this.#now = now
    this.#io = { readFile, mkdir, appendFile, ...io }
  }

  /** 项目库路径。 @returns {string} */
  get projectFile() {
    return join(this.#projectDir, EXPERIENCE_FILE)
  }

  /** 用户库路径。 @returns {string} */
  get globalFile() {
    return join(this.#globalDir, EXPERIENCE_FILE)
  }

  /**
   * 读一个文件里的全部事件（坏行跳过，不让一行脏数据弄崩整个库）。
   * @param {string} file
   * @returns {Promise<any[]>}
   */
  async #readEvents(file) {
    let raw
    try {
      raw = await this.#io.readFile(file, 'utf8')
    } catch (error) {
      if (/** @type {{code?: string}} */ (error).code === 'ENOENT') return []
      throw error
    }
    /** @type {any[]} */
    const out = []
    for (const line of String(raw).split('\n')) {
      if (line.trim() === '') continue
      try {
        const parsed = JSON.parse(line)
        if (parsed && typeof parsed === 'object' && typeof parsed.titleKey === 'string') out.push(parsed)
      } catch {
        // 坏行跳过
      }
    }
    return out
  }

  /**
   * 两级合并：先项目后全局。
   * - 首次出现的 titleKey 建记录（内容取自该级）；
   * - 之后每次出现只累加 verified_count 与 sources；
   * - 项目级内容优先：全局行不会覆盖已经来自项目级的 lesson/root_cause/fix/tags。
   *
   * @returns {Promise<any[]>}
   */
  async all() {
    /** @type {Map<string, any>} */
    const merged = new Map()
    /**
     * @param {string} level
     * @param {any[]} events
     */
    const fold = (level, events) => {
      for (const event of events) {
        const key = String(event.titleKey)
        const existing = merged.get(key)
        if (existing === undefined) {
          merged.set(key, {
            titleKey: key,
            title: text(event.title),
            lesson: text(event.lesson),
            root_cause: text(event.root_cause),
            fix: text(event.fix),
            tags: Array.isArray(event.tags) ? event.tags.map(String) : [],
            scope: EXPERIENCE_SCOPES.includes(event.scope) ? event.scope : level,
            level,
            sourceCardId: text(event.sourceCardId),
            sources: text(event.sourceCardId) === '' ? [] : [text(event.sourceCardId)],
            verified_count: 1,
            createdAt: Number.isSafeInteger(event.ts) ? event.ts : 0,
            updatedAt: Number.isSafeInteger(event.ts) ? event.ts : 0,
          })
          continue
        }
        existing.verified_count += 1
        const card = text(event.sourceCardId)
        if (card !== '' && !existing.sources.includes(card)) existing.sources.push(card)
        if (Number.isSafeInteger(event.ts)) existing.updatedAt = Math.max(existing.updatedAt, event.ts)
        // 全局级不覆盖项目级内容；项目级后到才补全（正常顺序下项目先读）
        if (existing.level === 'global' && level === 'project') {
          for (const field of ['title', 'lesson', 'root_cause', 'fix']) {
            const value = text(event[field])
            if (value !== '') existing[field] = value
          }
          if (Array.isArray(event.tags) && event.tags.length > 0) existing.tags = event.tags.map(String)
          existing.level = 'project'
        }
      }
    }
    fold('project', await this.#readEvents(this.projectFile))
    fold('global', await this.#readEvents(this.globalFile))
    return [...merged.values()]
  }

  /**
   * 写一条经验。同 title 已存在则只追加 verify 事件（verified_count+1、来源卡追加）。
   *
   * @param {{
   *   title: string, lesson: string, root_cause?: string, fix?: string,
   *   tags?: string[], scope?: string, sourceCardId?: string,
   * }} input
   * @returns {Promise<{action: 'created'|'verified', entry: any}>}
   */
  async save(input = {}) {
    const title = text(input.title)
    if (title === '') throw new ExperienceError('master_experience save 需要非空 title')
    const lesson = text(input.lesson)
    if (lesson === '') throw new ExperienceError('master_experience save 需要非空 lesson（一条可复用的教训）')
    const scope = input.scope === undefined ? 'project' : String(input.scope)
    if (!EXPERIENCE_SCOPES.includes(scope)) {
      throw new ExperienceError('scope 只能是 ' + EXPERIENCE_SCOPES.join(' / ') + '，实际收到 ' + JSON.stringify(input.scope))
    }
    const titleKey = normalizeTitle(title)
    const sourceCardId = text(input.sourceCardId)
    const now = this.#now()
    const dir = scope === 'global' ? this.#globalDir : this.#projectDir
    const file = scope === 'global' ? this.globalFile : this.projectFile

    const existing = (await this.all()).find((entry) => entry.titleKey === titleKey)
    /** @type {any} */
    const event = {
      op: existing === undefined ? 'save' : 'verify',
      titleKey,
      title,
      lesson,
      root_cause: text(input.root_cause),
      fix: text(input.fix),
      tags: Array.isArray(input.tags) ? input.tags.map(String) : [],
      scope,
      sourceCardId,
      ts: now,
    }
    await this.#io.mkdir(dir, { recursive: true })
    await this.#io.appendFile(file, JSON.stringify(event) + String.fromCharCode(10), 'utf8')

    const after = (await this.all()).find((entry) => entry.titleKey === titleKey)
    return { action: existing === undefined ? 'created' : 'verified', entry: after }
  }

  /**
   * 检索：按 tag / scope / 关键词（title+lesson）过滤。
   *
   * @param {{tag?: string, scope?: string, q?: string, limit?: number, offset?: number}} [filter]
   * @returns {Promise<any[]>}
   */
  async query(filter = {}) {
    let entries = await this.all()
    if (typeof filter.tag === 'string' && filter.tag !== '') {
      entries = entries.filter((entry) => entry.tags.includes(filter.tag))
    }
    if (typeof filter.scope === 'string' && filter.scope !== '') {
      entries = entries.filter((entry) => entry.scope === filter.scope)
    }
    if (typeof filter.q === 'string' && filter.q.trim() !== '') {
      const needle = filter.q.trim().toLowerCase()
      // 关键词覆盖四段正文：标题、教训、根因、修法（检索靠关键词与标签，没有向量召回 —— ADR-0003 已知代价）
      entries = entries.filter((entry) =>
        entry.title.toLowerCase().includes(needle) ||
        entry.lesson.toLowerCase().includes(needle) ||
        entry.root_cause.toLowerCase().includes(needle) ||
        entry.fix.toLowerCase().includes(needle))
    }
    return entries
  }

  /**
   * 分页列表：按最近更新倒序（最近验证过的排前面）。
   *
   * @param {{limit?: number, offset?: number}} [page]
   * @returns {Promise<{items: any[], total: number, limit: number, offset: number}>}
   */
  async list(page = {}) {
    const limit = Number.isSafeInteger(page.limit) && page.limit > 0 ? page.limit : 20
    const offset = Number.isSafeInteger(page.offset) && page.offset >= 0 ? page.offset : 0
    const entries = (await this.all()).sort((left, right) => right.updatedAt - left.updatedAt)
    return { items: entries.slice(offset, offset + limit), total: entries.length, limit, offset }
  }
}

/**
 * 造一个经验库（路径由调用方决定，测试可以指到临时目录）。
 * @param {{projectDir: string, globalDir?: string, now?: () => number, io?: Record<string, Function>}} options
 * @returns {ExperienceStore}
 */
export function createExperience(options) {
  return new ExperienceStore(options)
}
