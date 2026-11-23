/**
 * Issue Radar home — the triage loop.
 *
 * Protected: only signed-in users get here (AuthGate in the parent layout).
 *
 * 1. Add a repo (owner/repo + your stack) — a scan starts immediately.
 * 2. The `scan-repo` job fetches open issues, scores them, and streams
 *    candidates into the queue below via realtime `useQuery`.
 * 3. Triage each candidate: open it on GitHub, save it, or dismiss it.
 *
 * Scores are computed server-side by the scan job and never re-judged on
 * render; this page only reads and updates candidate `state`.
 */

import { useMemo, useState } from 'react'
import { useAuthProfileReady, useJobs, useMutations, useQuery } from 'deepspace'
import { SCOPE_ID } from '../../../constants'
import { Badge, Button, buttonVariants, EmptyState, Input } from '../../../components/ui'

interface RepoData {
  owner: string
  repo: string
  stack: string
  status: string
  lastScannedAt: string
  error: string
}

interface CandidateData {
  repoId: string
  number: number
  title: string
  url: string
  labels: string
  createdAt: string
  comments: number
  state: string
  score: number
  fitReasons: string
  judgedAt: string
}

interface ScanPayload {
  repoId: string
  owner: string
  repo: string
  stack: string
}

function scoreVariant(score: number): 'success' | 'warning' | 'secondary' {
  if (score >= 70) return 'success'
  if (score >= 40) return 'warning'
  return 'secondary'
}

function ageLabel(iso: string): string {
  const ms = Date.now() - Date.parse(iso)
  if (!Number.isFinite(ms) || ms < 0) return ''
  const days = Math.floor(ms / 86_400_000)
  if (days > 0) return `${days}d ago`
  const hours = Math.floor(ms / 3_600_000)
  if (hours > 0) return `${hours}h ago`
  return 'just now'
}

export default function HomePage() {
  const { user } = useAuthProfileReady({ requireUser: true })
  const { records: repos } = useQuery<RepoData>('repos', {
    orderBy: 'createdAt',
    orderDir: 'desc',
    limit: 50,
  })
  const { records: queued } = useQuery<CandidateData>('candidates', {
    where: { state: 'queued' },
    orderBy: 'score',
    orderDir: 'desc',
    limit: 50,
  })
  const { records: saved } = useQuery<CandidateData>('candidates', {
    where: { state: 'saved' },
    orderBy: 'score',
    orderDir: 'desc',
    limit: 10,
  })
  const repoMutations = useMutations<RepoData>('repos')
  const candidateMutations = useMutations<CandidateData>('candidates')
  const { jobs, enqueue } = useJobs<ScanPayload>(SCOPE_ID)

  const [owner, setOwner] = useState('')
  const [repo, setRepo] = useState('')
  const [stack, setStack] = useState('Python, backend')
  const [adding, setAdding] = useState(false)
  const [formError, setFormError] = useState('')

  const repoNameById = useMemo(() => {
    const map = new Map<string, string>()
    for (const r of repos) map.set(r.recordId, `${r.data.owner}/${r.data.repo}`)
    return map
  }, [repos])

  const activeScanByRepo = useMemo(() => {
    const map = new Map<string, { progress?: number; message?: string }>()
    for (const job of jobs) {
      if (job.type !== 'scan-repo') continue
      if (job.status !== 'queued' && job.status !== 'running') continue
      const payload = job.payload as ScanPayload | undefined
      if (!payload?.repoId) continue
      map.set(payload.repoId, {
        progress: job.progress,
        message: job.progressMessage,
      })
    }
    return map
  }, [jobs])

  async function scanRepo(recordId: string, data: RepoData) {
    await enqueue('scan-repo', {
      repoId: recordId,
      owner: data.owner,
      repo: data.repo,
      stack: data.stack,
    })
  }

  async function addRepo() {
    const cleanOwner = owner.trim()
    const cleanRepo = repo.trim()
    if (!cleanOwner || !cleanRepo || /[/\s]/.test(cleanOwner) || /[/\s]/.test(cleanRepo)) {
      setFormError('Enter a repo as owner and name, e.g. tiangolo / fastapi.')
      return
    }
    setFormError('')
    setAdding(true)
    try {
      const data: RepoData = {
        owner: cleanOwner,
        repo: cleanRepo,
        stack: stack.trim(),
        status: 'idle',
        lastScannedAt: '',
        error: '',
      }
      const id = await repoMutations.createConfirmed(data)
      setOwner('')
      setRepo('')
      await scanRepo(id, data)
    } finally {
      setAdding(false)
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-foreground">Issue Radar</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Track a repo, get its open issues scored as first bug-fixes for your stack, and
          triage the best ones.
          {user ? ` Signed in as ${user.name ?? user.email ?? 'you'}.` : ''}
        </p>
      </header>

      <section className="mb-8 rounded-lg border border-border bg-card p-4">
        <h2 className="mb-3 text-sm font-semibold text-foreground">Track a repo</h2>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
            placeholder="owner (e.g. tiangolo)"
            aria-label="Repo owner"
          />
          <Input
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            placeholder="repo (e.g. fastapi)"
            aria-label="Repo name"
          />
          <Input
            value={stack}
            onChange={(e) => setStack(e.target.value)}
            placeholder="Your stack (e.g. Python, backend)"
            aria-label="Your stack"
          />
          <Button onClick={addRepo} disabled={adding || !repoMutations.ready}>
            {adding ? 'Adding…' : 'Add & scan'}
          </Button>
        </div>
        {formError && <p className="mt-2 text-sm text-destructive">{formError}</p>}
        <p className="mt-2 text-xs text-muted-foreground">
          Scans run hourly after the first one, and a 9am digest emails new issues scored
          70+.
        </p>
      </section>

      <section className="mb-8">
        <h2 className="mb-3 text-sm font-semibold text-foreground">Your repos</h2>
        {repos.length === 0 ? (
          <EmptyState
            title="No repos yet"
            description="Add tiangolo/fastapi or any public repo above to see its open issues scored."
          />
        ) : (
          <ul className="space-y-2">
            {repos.map((r) => {
              const active = activeScanByRepo.get(r.recordId)
              const scanning = r.data.status === 'scanning' || Boolean(active)
              return (
                <li
                  key={r.recordId}
                  className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card px-4 py-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">
                      {r.data.owner}/{r.data.repo}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {r.data.stack}
                      {r.data.lastScannedAt
                        ? ` · last scanned ${ageLabel(r.data.lastScannedAt)}`
                        : ''}
                      {active?.message ? ` · ${active.message}` : ''}
                    </p>
                    {r.data.status === 'error' && r.data.error && (
                      <p className="mt-1 text-xs text-destructive">
                        Scan failed: {r.data.error}
                      </p>
                    )}
                  </div>
                  {scanning && typeof active?.progress === 'number' && (
                    <span className="text-xs text-muted-foreground">
                      {Math.round(active.progress * 100)}%
                    </span>
                  )}
                  <Badge variant={scanning ? 'info' : r.data.status === 'error' ? 'destructive' : 'secondary'}>
                    {scanning ? 'scanning' : r.data.status}
                  </Badge>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={scanning || !repoMutations.ready}
                    onClick={() => void scanRepo(r.recordId, r.data)}
                  >
                    Scan now
                  </Button>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <section className="mb-8">
        <h2 className="mb-3 text-sm font-semibold text-foreground">
          Triage queue · {queued.length} waiting
        </h2>
        {queued.length === 0 ? (
          <EmptyState
            title="Queue is clear"
            description="Scan a repo and its best first-bug-fix candidates will appear here, highest score first."
          />
        ) : (
          <ul className="space-y-3">
            {queued.map((c) => (
              <li
                key={c.recordId}
                className="rounded-lg border border-border bg-card p-4"
              >
                <div className="flex items-start gap-3">
                  <Badge variant={scoreVariant(c.data.score)} size="lg">
                    {c.data.score}
                  </Badge>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-foreground">
                      #{c.data.number} {c.data.title}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {repoNameById.get(c.data.repoId) ?? ''}
                      {c.data.labels ? ` · ${c.data.labels}` : ''}
                      {` · ${ageLabel(c.data.createdAt)} · ${c.data.comments} comments`}
                    </p>
                    {c.data.fitReasons && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        Why it fits: {c.data.fitReasons}
                      </p>
                    )}
                  </div>
                </div>
                <div className="mt-3 flex gap-2">
                  <a
                    className={buttonVariants({ variant: 'outline', size: 'sm' })}
                    href={c.data.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open on GitHub
                  </a>
                  <Button
                    size="sm"
                    disabled={!candidateMutations.ready}
                    onClick={() =>
                      void candidateMutations.put(c.recordId, { state: 'saved' })
                    }
                  >
                    Save
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!candidateMutations.ready}
                    onClick={() =>
                      void candidateMutations.put(c.recordId, { state: 'dismissed' })
                    }
                  >
                    Dismiss
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {saved.length > 0 && (
        <section>
          <h2 className="mb-3 text-sm font-semibold text-foreground">
            Saved · {saved.length}
          </h2>
          <ul className="space-y-2">
            {saved.map((c) => (
              <li
                key={c.recordId}
                className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card px-4 py-2.5"
              >
                <Badge variant={scoreVariant(c.data.score)}>{c.data.score}</Badge>
                <p className="min-w-0 flex-1 truncate text-sm text-foreground">
                  #{c.data.number} {c.data.title}
                </p>
                <a
                  className={buttonVariants({ variant: 'outline', size: 'sm' })}
                  href={c.data.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open
                </a>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!candidateMutations.ready}
                  onClick={() =>
                    void candidateMutations.put(c.recordId, { state: 'queued' })
                  }
                >
                  Back to queue
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
