import type {
  Thread,
  ThreadItem,
  ThreadReadResponse,
  ThreadListResponse,
  Turn,
  UserInput,
} from '../appServerDtos'
import type { CommandExecutionData, UiFileAttachment, UiFileChangeData, UiMessage, UiProjectGroup, UiThread } from '../../types/codex'

function toIso(seconds: number): string {
  return new Date(seconds * 1000).toISOString()
}

function toProjectName(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean)
  return parts.at(-1) || cwd || 'unknown-project'
}

function toRawPayload(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

const FILE_ATTACHMENT_LINE = /^##\s+(.+?):\s+(.+?)\s*$/
const FILES_MENTIONED_MARKER = /^#\s*files mentioned by the user\s*:?\s*$/i

function extractFileAttachments(value: string): UiFileAttachment[] {
  const markerIdx = value.split('\n').findIndex((line) => FILES_MENTIONED_MARKER.test(line.trim()))
  if (markerIdx < 0) return []
  const lines = value.split('\n').slice(markerIdx + 1)
  const attachments: UiFileAttachment[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const m = trimmed.match(FILE_ATTACHMENT_LINE)
    if (!m) break
    const label = m[1]?.trim()
    const path = m[2]?.trim().replace(/\s+\((?:lines?\s+\d+(?:-\d+)?)\)\s*$/, '')
    if (label && path) attachments.push({ label, path })
  }
  return attachments
}

function extractCodexUserRequestText(value: string): string {
  const markerRegex = /(?:^|\n)\s{0,3}#{0,6}\s*my request for codex\s*:?\s*/giu
  const matches = Array.from(value.matchAll(markerRegex))
  if (matches.length === 0) {
    return value.trim()
  }

  const lastMatch = matches.at(-1)
  if (!lastMatch || typeof lastMatch.index !== 'number') {
    return value.trim()
  }

  const markerOffset = lastMatch.index + lastMatch[0].length
  return value.slice(markerOffset).trim()
}

function parseUserMessageContent(
  itemId: string,
  content: UserInput[] | undefined,
): { text: string; images: string[]; fileAttachments: UiFileAttachment[]; rawBlocks: UiMessage[] } {
  if (!Array.isArray(content)) return { text: '', images: [], fileAttachments: [], rawBlocks: [] }

  const textChunks: string[] = []
  const images: string[] = []
  const rawBlocks: UiMessage[] = []

  for (const [index, block] of content.entries()) {
    if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
      textChunks.push(block.text)
    }
    if (block.type === 'image' && typeof block.url === 'string' && block.url.trim().length > 0) {
      images.push(block.url.trim())
    }

    if (block.type !== 'text' && block.type !== 'image') {
      rawBlocks.push({
        id: `${itemId}:user-content:${index}`,
        role: 'user',
        text: '',
        messageType: `userContent.${block.type}`,
        rawPayload: toRawPayload(block),
        isUnhandled: true,
      })
    }
  }

  const fullText = textChunks.join('\n')
  const fileAttachments = extractFileAttachments(fullText)

  return {
    text: extractCodexUserRequestText(fullText),
    images,
    fileAttachments,
    rawBlocks,
  }
}

function toUiMessages(item: ThreadItem): UiMessage[] {
  if (item.type === 'agentMessage') {
    return [
      {
        id: item.id,
        role: 'assistant',
        text: item.text,
        messageType: item.type,
      },
    ]
  }

  if (item.type === 'userMessage') {
    const parsed = parseUserMessageContent(item.id, item.content as UserInput[] | undefined)
    const messages: UiMessage[] = []
    const hasRenderableUserContent = parsed.text.length > 0 || parsed.images.length > 0 || parsed.fileAttachments.length > 0

    if (hasRenderableUserContent) {
      messages.push({
        id: item.id,
        role: 'user',
        text: parsed.text,
        images: parsed.images,
        fileAttachments: parsed.fileAttachments.length > 0 ? parsed.fileAttachments : undefined,
        messageType: item.type,
      })
    }

    messages.push(...parsed.rawBlocks)
    if (messages.length === 0) {
      return []
    }

    return messages
  }

  if (item.type === 'reasoning') {
    return []
  }

  if (item.type === 'commandExecution') {
    const raw = item as Record<string, unknown>
    const status = normalizeCommandStatus(raw.status)
    const cmd = typeof raw.command === 'string' ? raw.command : ''
    const cwd = typeof raw.cwd === 'string' ? raw.cwd : null
    const aggregatedOutput = typeof raw.aggregatedOutput === 'string' ? raw.aggregatedOutput : ''
    const exitCode = typeof raw.exitCode === 'number' ? raw.exitCode : null
    return [
      {
        id: item.id,
        role: 'system' as const,
        text: cmd,
        messageType: 'commandExecution',
        commandExecution: { command: cmd, cwd, status, aggregatedOutput, exitCode },
      },
    ]
  }

  if (item.type === 'fileChange') {
    const raw = item as Record<string, unknown>
    const status = normalizeFileChangeStatus(raw.status)
    const changes = Array.isArray(raw.changes) ? raw.changes : []
    const messages: UiMessage[] = []

    for (const [index, change] of changes.entries()) {
      if (!change || typeof change !== 'object' || Array.isArray(change)) continue
      const row = change as Record<string, unknown>
      const path = typeof row.path === 'string' ? row.path.trim() : ''
      if (!path) continue

      const diff = typeof row.diff === 'string' ? row.diff : ''
      const { kind, movePath } = readFileChangeKind(row.kind)
      const { linesAdded, linesRemoved, openLine } = readFileChangeDiffStats(diff)

      messages.push({
        id: `${item.id}:change:${index}`,
        role: 'system',
        text: path,
        messageType: 'fileChange',
        fileChange: {
          path,
          kind,
          status,
          diff,
          movePath,
          linesAdded,
          linesRemoved,
          openLine,
        },
      })
    }

    return messages
  }

  return []
}

function normalizeCommandStatus(value: unknown): CommandExecutionData['status'] {
  if (value === 'completed' || value === 'failed' || value === 'declined' || value === 'interrupted') return value
  if (value === 'inProgress' || value === 'in_progress') return 'inProgress'
  return 'completed'
}

function normalizeFileChangeStatus(value: unknown): UiFileChangeData['status'] {
  if (value === 'inProgress' || value === 'completed' || value === 'failed' || value === 'declined') {
    return value
  }
  return 'completed'
}

function readFileChangeKind(value: unknown): Pick<UiFileChangeData, 'kind' | 'movePath'> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    const type = record.type
    if (type === 'add' || type === 'delete' || type === 'update') {
      const movePath =
        type === 'update' && typeof record.move_path === 'string' && record.move_path.trim().length > 0
          ? record.move_path.trim()
          : null
      return { kind: type, movePath }
    }
  }

  return { kind: 'update', movePath: null }
}

function readFileChangeDiffStats(diff: string): Pick<UiFileChangeData, 'linesAdded' | 'linesRemoved' | 'openLine'> {
  if (!diff.trim()) {
    return {
      linesAdded: 0,
      linesRemoved: 0,
      openLine: null,
    }
  }

  let linesAdded = 0
  let linesRemoved = 0
  let openLine: number | null = null
  let nextOldLine: number | null = null
  let nextNewLine: number | null = null

  for (const line of diff.split(/\r?\n/u)) {
    const hunkMatch = line.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/u)
    if (hunkMatch) {
      nextOldLine = Number(hunkMatch[1])
      nextNewLine = Number(hunkMatch[2])
      if (openLine === null) {
        openLine = nextNewLine > 0 ? nextNewLine : nextOldLine
      }
      continue
    }

    if (
      line.startsWith('diff --git ') ||
      line.startsWith('index ') ||
      line.startsWith('+++ ') ||
      line.startsWith('--- ') ||
      line.startsWith('Binary files ')
    ) {
      continue
    }

    if (line.startsWith('+')) {
      linesAdded += 1
      if (openLine === null && nextNewLine !== null) {
        openLine = nextNewLine
      }
      if (nextNewLine !== null) nextNewLine += 1
      continue
    }

    if (line.startsWith('-')) {
      linesRemoved += 1
      if (openLine === null && nextOldLine !== null) {
        openLine = nextOldLine
      }
      if (nextOldLine !== null) nextOldLine += 1
      continue
    }

    if (line.startsWith(' ')) {
      if (nextOldLine !== null) nextOldLine += 1
      if (nextNewLine !== null) nextNewLine += 1
    }
  }

  return {
    linesAdded,
    linesRemoved,
    openLine,
  }
}

function pickThreadName(summary: Thread): string {
  const direct = [summary.preview]
  for (const candidate of direct) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim()
    }
  }
  return ''
}

function toThreadTitle(summary: Thread): string {
  const named = pickThreadName(summary)
  return named.length > 0 ? named : 'Untitled thread'
}

function isTurnInProgress(turn: Turn | null | undefined): boolean {
  return turn?.status === 'inProgress'
}

function readThreadInProgress(summary: Thread): boolean {
  const rawSummary = summary as Record<string, unknown>
  if (rawSummary.inProgress === true) return true
  if (rawSummary.status === 'inProgress' || rawSummary.turnStatus === 'inProgress') return true

  const turns = Array.isArray(summary.turns) ? summary.turns : []
  const lastTurn = turns.at(-1)
  return isTurnInProgress(lastTurn)
}

function toUiThread(summary: Thread): UiThread {
  const rawSummary = summary as Record<string, unknown>
  const cwd = typeof rawSummary.cwd === 'string' ? rawSummary.cwd : summary.cwd
  const hasWorktree =
    rawSummary.isWorktree === true ||
    rawSummary.worktree === true ||
    rawSummary.worktreeId !== undefined ||
    rawSummary.worktreePath !== undefined ||
    cwd.includes('/.codex/worktrees/') ||
    cwd.includes('/.git/worktrees/')

  return {
    id: summary.id,
    title: toThreadTitle(summary),
    projectName: toProjectName(summary.cwd),
    cwd: summary.cwd,
    hasWorktree,
    createdAtIso: toIso(summary.createdAt),
    updatedAtIso: toIso(summary.updatedAt),
    preview: summary.preview,
    unread: false,
    inProgress: readThreadInProgress(summary),
  }
}

function groupThreadsByProject(threads: UiThread[]): UiProjectGroup[] {
  const grouped = new Map<string, UiThread[]>()
  for (const thread of threads) {
    const rows = grouped.get(thread.projectName)
    if (rows) rows.push(thread)
    else grouped.set(thread.projectName, [thread])
  }

  return Array.from(grouped.entries())
    .map(([projectName, projectThreads]) => ({
      projectName,
      threads: projectThreads.sort(
        (a, b) => new Date(b.updatedAtIso).getTime() - new Date(a.updatedAtIso).getTime(),
      ),
    }))
    .sort((a, b) => {
      const aLast = new Date(a.threads[0]?.updatedAtIso ?? 0).getTime()
      const bLast = new Date(b.threads[0]?.updatedAtIso ?? 0).getTime()
      return bLast - aLast
    })
}

export function normalizeThreadGroupsV2(payload: ThreadListResponse): UiProjectGroup[] {
  const uiThreads = payload.data.map(toUiThread)
  return groupThreadsByProject(uiThreads)
}

export function normalizeThreadMessagesV2(payload: ThreadReadResponse): UiMessage[] {
  const turns = Array.isArray(payload.thread.turns) ? payload.thread.turns : []
  const messages: UiMessage[] = []
  for (let turnIndex = 0; turnIndex < turns.length; turnIndex++) {
    const turn = turns[turnIndex]
    const items = Array.isArray(turn.items) ? turn.items : []
    for (const item of items) {
      for (const msg of toUiMessages(item)) {
        messages.push({ ...msg, turnIndex })
      }
    }
  }
  return messages
}

export function normalizeThreadItemV2(item: ThreadItem): UiMessage[] {
  return toUiMessages(item)
}

export function readThreadInProgressFromResponse(payload: ThreadReadResponse): boolean {
  const turns = Array.isArray(payload.thread.turns) ? payload.thread.turns : []
  return isTurnInProgress(turns.at(-1))
}
