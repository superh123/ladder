/**
 * Issue Radar — repo scan engine.
 *
 * Shared by the `scan-repo` background job (src/jobs.ts) and the hourly
 * rescan cron (src/cron.ts). Both callers hand it a `CronContext` — the
 * SDK's server-side data client, built with `buildCronContext(env, ...)`:
 * it queries/creates/updates RecordRoom rows directly and calls platform
 * integrations billed to the app owner. Jobs have no built-in records or
 * integration client of their own, so reusing the cron context here is
 * the supported path (it only needs RECORD_ROOMS + APP_OWNER_JWT from env).
 *
 * Pipeline per repo:
 *   1. `github/get-repository-issues` — open issues, PRs filtered out.
 *   2. Deterministic 0–100 fit score (labels, age, comment count).
 *   3. One batched `anthropic/chat-completion` (Haiku) call re-scores the
 *      top 15 — any failure falls back to the deterministic score, so the
 *      queue still fills.
 *   4. Upsert `candidates` rows (never overwrites a save/dismiss).
 */

import type { CronContext } from 'deepspace/worker'

export interface RepoRef {
  recordId: string
  owner: string
  repo: string
  stack: string
}

export interface ScanResult {
  issuesFound: number
  candidatesUpserted: number
  judged: number
}

interface GhIssue {
  number: number
  title: string
  url: string
  labels: string
  createdAt: string
  comments: number
  body: string
}

type Progress = (value: number, message?: string) => void

// ---------------------------------------------------------------------------
// Defensive shape helpers — integration responses are `unknown`.
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null
}

/** RecordRoom rows arrive as { recordId, data, createdBy, ... }. */
export function rowData(row: unknown): Record<string, unknown> {
  const rec = asRecord(row)
  if (!rec) return {}
  const data = asRecord(rec.data)
  return data ?? rec
}

export function rowId(row: unknown): string {
  return String(asRecord(row)?.recordId ?? '')
}

export function rowCreatedBy(row: unknown): string {
  return String(asRecord(row)?.createdBy ?? '')
}

function toStr(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function toNum(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function unwrapList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  const rec = asRecord(value)
  if (!rec) return []
  for (const key of ['issues', 'data', 'results', 'items']) {
    if (Array.isArray(rec[key])) return rec[key] as unknown[]
  }
  return []
}

/** Pull the reply text out of an Anthropic/OpenAI-shaped response. */
function responseText(value: unknown): string {
  if (typeof value === 'string') return value
  const rec = asRecord(value)
  if (!rec) return ''
  if (typeof rec.text === 'string') return rec.text
  const content = rec.content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        return toStr(asRecord(part)?.text)
      })
      .join('')
  }
  if (typeof content === 'string') return content
  const choices = rec.choices
  if (Array.isArray(choices)) {
    const first = asRecord(choices[0])
    const message = asRecord(first?.message)
    if (typeof message?.content === 'string') return message.content
  }
  return ''
}

// ---------------------------------------------------------------------------
// Deterministic scoring — always available, even if the AI judge is down.
// ---------------------------------------------------------------------------

export function deterministicScore(issue: GhIssue, now: Date): {
  score: number
  reasons: string
} {
  const labelList = issue.labels
    .split(',')
    .map((l) => l.trim().toLowerCase())
    .filter(Boolean)
  const reasons: string[] = []
  let score = 25

  const has = (...needles: string[]) =>
    labelList.some((l) => needles.some((n) => l.includes(n)))

  if (has('good first issue', 'good-first-issue', 'good first')) {
    score += 35
    reasons.push('good first issue')
  }
  if (has('help wanted', 'help-wanted')) {
    score += 20
    reasons.push('help wanted')
  }
  if (has('bug')) {
    score += 15
    reasons.push('bug')
  }
  if (has('beginner', 'easy', 'starter')) {
    score += 10
    reasons.push('beginner-friendly')
  }
  if (has('documentation', 'docs')) {
    score -= 10
    reasons.push('docs, not code')
  }

  const ageDays = Math.max(
    0,
    Math.floor((now.getTime() - Date.parse(issue.createdAt)) / 86_400_000),
  )
  if (ageDays <= 30) {
    score += 15
    reasons.push(`opened ${ageDays}d ago`)
  } else if (ageDays <= 90) {
    score += 8
  }

  if (issue.comments <= 2) {
    score += 10
    reasons.push('few comments — likely unclaimed')
  } else if (issue.comments <= 10) {
    score += 5
  } else if (issue.comments > 20) {
    score -= 10
    reasons.push('long thread — may be contested')
  }

  return {
    score: Math.max(0, Math.min(100, score)),
    reasons: reasons.join('; ') || 'open issue',
  }
}

// ---------------------------------------------------------------------------
// GitHub response → normalized issues (PRs excluded: the issues endpoint
// returns pull requests too, flagged with a `pull_request` field).
// ---------------------------------------------------------------------------

function normalizeIssues(raw: unknown): GhIssue[] {
  return unwrapList(raw)
    .map((item) => {
      const rec = asRecord(item)
      if (!rec) return null
      if (rec.pull_request) return null
      const number = toNum(rec.number, -1)
      if (number < 0) return null
      const labels = rec.labels
      const labelNames = Array.isArray(labels)
        ? labels
            .map((l) => {
              if (typeof l === 'string') return l
              return toStr(asRecord(l)?.name)
            })
            .filter(Boolean)
        : []
      return {
        number,
        title: toStr(rec.title) || `#${number}`,
        url: toStr(rec.html_url) || toStr(rec.url),
        labels: labelNames.join(', '),
        createdAt: toStr(rec.created_at) || new Date().toISOString(),
        comments: toNum(rec.comments, 0),
        body: toStr(rec.body).slice(0, 400),
      } satisfies GhIssue
    })
    .filter((i): i is GhIssue => i !== null)
}

// ---------------------------------------------------------------------------
// AI judge — one batched call for the top 15. Returns number → {score, reasons}.
// Any failure (call error, bad JSON) yields an empty map: callers fall back
// to the deterministic score.
// ---------------------------------------------------------------------------

async function judgeIssues(
  server: CronContext,
  stack: string,
  issues: GhIssue[],
): Promise<Map<number, { score: number; reasons: string }>> {
  const judged = new Map<number, { score: number; reasons: string }>()
  if (issues.length === 0) return judged
  const prompt = [
    'You score GitHub issues as first bug-fix tasks for an open-source contributor.',
    `Contributor stack: ${stack || 'general backend'}.`,
    'Higher = small, well-scoped code fix a newcomer to the repo could land. Lower = vague, huge, discussion-only, or needs deep repo knowledge.',
    'Reply with ONLY a JSON array, one object per issue: [{"number": 123, "score": 82, "reasons": "short reason, max 12 words"}].',
    '',
    ...issues.map(
      (i) =>
        `#${i.number} ${i.title} [labels: ${i.labels || 'none'}; comments: ${i.comments}] ${i.body}`,
    ),
  ].join('\n')
  try {
    const raw = await server.integrations.call('anthropic/chat-completion', {
      model: 'claude-haiku-5-5',
      max_tokens: 1200,
      messages: [{ role: 'user', content: prompt }],
    })
    const text = responseText(raw)
    const start = text.indexOf('[')
    const end = text.lastIndexOf(']')
    if (start < 0 || end <= start) return judged
    const parsed: unknown = JSON.parse(text.slice(start, end + 1))
    if (!Array.isArray(parsed)) return judged
    for (const entry of parsed) {
      const rec = asRecord(entry)
      if (!rec) continue
      const number = toNum(rec.number, -1)
      const score = toNum(rec.score, -1)
      if (number < 0 || score < 0 || score > 100) continue
      judged.set(number, {
        score: Math.round(score),
        reasons: toStr(rec.reasons).slice(0, 120) || 'AI-judged fit',
      })
    }
  } catch {
    // Judge is a bonus — deterministic scores stand.
  }
  return judged
}

// ---------------------------------------------------------------------------
// The scan itself.
// ---------------------------------------------------------------------------

export async function scanRepo(
  server: CronContext,
  repo: RepoRef,
  onProgress?: Progress,
): Promise<ScanResult> {
  const now = new Date()
  const nowIso = now.toISOString()
  const report = (value: number, message: string) => onProgress?.(value, message)

  await server.records.update('repos', repo.recordId, {
    status: 'scanning',
    error: '',
  })
  try {
    report(0.1, `Fetching open issues for ${repo.owner}/${repo.repo}`)
    const raw = await server.integrations.call('github/get-repository-issues', {
      owner: repo.owner,
      repo: repo.repo,
      state: 'open',
      per_page: 30,
    })
    const issues = normalizeIssues(raw)
    report(0.3, `Found ${issues.length} open issues`)

    const scored = issues.map((issue) => ({
      issue,
      ...deterministicScore(issue, now),
    }))
    scored.sort((a, b) => b.score - a.score)

    report(0.5, 'AI-judging the best fits')
    const judged = await judgeIssues(
      server,
      repo.stack,
      scored.slice(0, 15).map((s) => s.issue),
    )
    for (const entry of scored) {
      const ai = judged.get(entry.issue.number)
      if (ai) {
        entry.score = ai.score
        entry.reasons = ai.reasons
      }
    }

    report(0.7, 'Saving candidates')
    const existing = await server.records.query('candidates', {
      where: { repoId: repo.recordId },
      limit: 100,
    })
    const byNumber = new Map<number, { recordId: string; state: string }>()
    for (const row of existing) {
      const data = rowData(row)
      const number = toNum(data.number, -1)
      if (number >= 0 && rowId(row)) {
        byNumber.set(number, {
          recordId: rowId(row),
          state: toStr(data.state) || 'queued',
        })
      }
    }

    let upserted = 0
    for (const entry of scored) {
      const { issue } = entry
      const prev = byNumber.get(issue.number)
      const data = {
        repoId: repo.recordId,
        number: issue.number,
        title: issue.title,
        url: issue.url,
        labels: issue.labels,
        createdAt: issue.createdAt,
        comments: issue.comments,
        state: prev?.state ?? 'queued',
        score: entry.score,
        fitReasons: entry.reasons,
        judgedAt: nowIso,
      }
      if (prev) {
        await server.records.update('candidates', prev.recordId, data)
      } else {
        await server.records.create('candidates', data)
      }
      upserted += 1
    }

    await server.records.update('repos', repo.recordId, {
      status: 'idle',
      lastScannedAt: nowIso,
    })
    report(1, `Done — ${issues.length} issues, ${upserted} candidates`)
    return { issuesFound: issues.length, candidatesUpserted: upserted, judged: judged.size }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await server.records
      .update('repos', repo.recordId, {
        status: 'error',
        error: message.slice(0, 500),
      })
      .catch(() => undefined)
    throw error
  }
}
