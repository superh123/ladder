/**
 * Ladder — the game page.
 *
 * Public: no sign-in anywhere. It lives under (app)/ for the data layer
 * (presence) but outside (protected)/, so anonymous visitors play the
 * daily freely. Personal stats live in localStorage; scores reach the
 * worker's public routes, which validate everything server-side.
 *
 * The client never imports the engine (src/lib/ladder.ts): the guess
 * graph and the BFS solver stay server-side, and the par is only ever
 * revealed after a finish or a forfeit.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { usePresenceRoom } from 'deepspace'
import { Button, Input } from '@/components/ui'
import { Modal } from '@/components/ui/Modal'

interface DailyInfo {
  date: string
  number: number
  start: string
  end: string
}

interface BoardEntry {
  name: string
  steps: number
  seconds: number
  seeded: boolean
}

interface FinishResult {
  steps: number
  par: number
  optimalPath: string[]
  isPar: boolean
  isBest?: boolean
  rank?: number
  total?: number
  gaveUp: boolean
  needsName?: boolean
}

interface Stats {
  lastPlayedDate: string | null
  streak: number
  maxStreak: number
  played: number
  parHits: number
  lastParDate: string | null
}

const STATS_KEY = 'ladder-stats-v1'
const NAME_KEY = 'ladder-name'

function loadStats(): Stats {
  try {
    const raw = localStorage.getItem(STATS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Stats>
      return {
        lastPlayedDate: parsed.lastPlayedDate ?? null,
        streak: parsed.streak ?? 0,
        maxStreak: parsed.maxStreak ?? 0,
        played: parsed.played ?? 0,
        parHits: parsed.parHits ?? 0,
        lastParDate: parsed.lastParDate ?? null,
      }
    }
  } catch {
    // Corrupt stats are not worth crashing over — start fresh.
  }
  return {
    lastPlayedDate: null,
    streak: 0,
    maxStreak: 0,
    played: 0,
    parHits: 0,
    lastParDate: null,
  }
}

function yesterdayStr(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00.000Z`)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

function formatTime(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

/** Index of the single differing letter between two 4-letter words. */
function diffIndex(a: string, b: string): number {
  let diff = -1
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      if (diff !== -1) return -1
      diff = i
    }
  }
  return diff
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return (await res.json()) as T
}

export default function PlayPage() {
  const [mode, setMode] = useState<'daily' | 'practice'>('daily')
  const [daily, setDaily] = useState<DailyInfo | null>(null)
  const [practicePair, setPracticePair] = useState<{ start: string; end: string } | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [path, setPath] = useState<string[]>([])
  const [input, setInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [shakeNonce, setShakeNonce] = useState(0)
  const [phase, setPhase] = useState<'playing' | 'finished'>('playing')
  const [result, setResult] = useState<FinishResult | null>(null)
  const [hintsUsed, setHintsUsed] = useState(0)
  const [hintBusy, setHintBusy] = useState(false)
  const [name, setName] = useState(() => {
    try {
      return localStorage.getItem(NAME_KEY) ?? ''
    } catch {
      return ''
    }
  })
  const [savedName, setSavedName] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [board, setBoard] = useState<BoardEntry[] | null>(null)
  const [stats, setStats] = useState<Stats>(loadStats)
  const [elapsed, setElapsed] = useState(0)
  const [showHood, setShowHood] = useState(false)
  const [copied, setCopied] = useState(false)
  const startAtRef = useRef<number | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const pair = mode === 'daily' ? daily : practicePair
  const start = pair?.start ?? ''
  const end = pair?.end ?? ''

  // Presence: who else is on today's puzzle right now.
  const { peers, connected } = usePresenceRoom(daily ? `ladder:${daily.date}` : 'ladder:loading')

  const refreshBoard = useCallback(async (date: string) => {
    try {
      const res = await fetch(`/api/leaderboard?date=${date}`)
      const data = (await res.json()) as { entries: BoardEntry[] }
      setBoard(data.entries ?? [])
    } catch {
      // The board is a bonus — a failed fetch must not break the game.
      setBoard(null)
    }
  }, [])

  const loadDaily = useCallback(async () => {
    setLoadError(null)
    try {
      const res = await fetch('/api/daily')
      const data = (await res.json()) as DailyInfo
      setDaily(data)
      setPath([data.start])
      void refreshBoard(data.date)
    } catch {
      setLoadError('Could not load today’s ladder. Check your connection and try again.')
    }
  }, [refreshBoard])

  const loadPractice = useCallback(async () => {
    setLoadError(null)
    try {
      const res = await fetch('/api/practice')
      const data = (await res.json()) as { start: string; end: string }
      setPracticePair(data)
      setPath([data.start])
    } catch {
      setLoadError('Could not load a practice ladder. Check your connection and try again.')
    }
  }, [])

  useEffect(() => {
    void loadDaily()
  }, [loadDaily])

  // Timer: starts on the first accepted rung, stops on finish.
  useEffect(() => {
    if (phase !== 'playing' || startAtRef.current === null) return
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startAtRef.current!) / 1000))
    }, 500)
    return () => clearInterval(id)
  }, [phase])

  const focusInput = () => inputRef.current?.focus()

  function recordDailyFinish(isPar: boolean, date: string) {
    setStats((prev) => {
      if (prev.lastPlayedDate === date) {
        // Already counted today (unlimited retries) — only a first par counts.
        if (isPar && prev.lastParDate !== date) {
          const next = { ...prev, parHits: prev.parHits + 1, lastParDate: date }
          try {
            localStorage.setItem(STATS_KEY, JSON.stringify(next))
          } catch {
            // localStorage full/blocked — stats just won't persist.
          }
          return next
        }
        return prev
      }
      const streak = prev.lastPlayedDate === yesterdayStr(date) ? prev.streak + 1 : 1
      const next: Stats = {
        lastPlayedDate: date,
        streak,
        maxStreak: Math.max(prev.maxStreak, streak),
        played: prev.played + 1,
        parHits: isPar ? prev.parHits + 1 : prev.parHits,
        lastParDate: isPar ? date : prev.lastParDate,
      }
      try {
        localStorage.setItem(STATS_KEY, JSON.stringify(next))
      } catch {
        // localStorage full/blocked — stats just won't persist.
      }
      return next
    })
  }

  async function submitScore(
    playerName: string,
    seconds: number,
    hints: number,
    finalPath: string[],
  ) {
    if (!daily) return
    setSaving(true)
    try {
      const data = await postJson<{
        valid: boolean
        steps: number
        par: number
        optimalPath: string[]
        isPar: boolean
        isBest: boolean
        rank: number
        total: number
        error?: string
      }>('/api/submit', {
        date: daily.date,
        path: finalPath,
        name: playerName,
        seconds,
        hintsUsed: hints,
      })
      if (!data.valid) {
        setError(data.error ?? 'The server rejected that path.')
        setShakeNonce((n) => n + 1)
        return
      }
      try {
        localStorage.setItem(NAME_KEY, playerName)
      } catch {
        // Non-fatal.
      }
      setSavedName(playerName)
      setResult({
        steps: data.steps,
        par: data.par,
        optimalPath: data.optimalPath,
        isPar: data.isPar,
        isBest: data.isBest,
        rank: data.rank,
        total: data.total,
        gaveUp: false,
      })
      recordDailyFinish(data.isPar, daily.date)
      void refreshBoard(daily.date)
    } finally {
      setSaving(false)
    }
  }

  async function finishPath(finalPath: string[]) {
    if (!pair) return
    const seconds = startAtRef.current === null ? 0 : Math.floor((Date.now() - startAtRef.current) / 1000)
    setPhase('finished')
    if (mode === 'practice') {
      try {
        const data = await postJson<{
          valid: boolean
          steps: number
          par: number
          optimalPath: string[]
          isPar: boolean
          error?: string
        }>('/api/reveal', { start: pair.start, end: pair.end, path: finalPath, hintsUsed })
        if (!data.valid) {
          setError(data.error ?? 'The server rejected that path.')
          setPhase('playing')
          return
        }
        setResult({
          steps: data.steps,
          par: data.par,
          optimalPath: data.optimalPath,
          isPar: data.isPar,
          gaveUp: false,
        })
      } catch {
        setError('Could not reach the server to score that path.')
        setPhase('playing')
      }
      return
    }
    // Daily: auto-save when we already know the player's name.
    const trimmed = name.trim()
    if (trimmed) {
      await submitScore(trimmed, seconds, hintsUsed, finalPath)
    } else {
      // Score is computed by the submit call, so without a name we show
      // the result only after the player names themself below.
      setResult(null)
      setPhase('finished')
      setPendingFinish({ seconds })
    }
  }

  // Finish state held while waiting for a display name.
  const [pendingFinish, setPendingFinish] = useState<{ seconds: number } | null>(null)

  async function saveWithName() {
    const trimmed = name.trim()
    if (!trimmed || !pendingFinish) return
    await submitScore(trimmed, pendingFinish.seconds, hintsUsed, path)
    setPendingFinish(null)
  }

  async function submitWord() {
    if (!pair || phase !== 'playing') return
    const word = input.trim().toLowerCase()
    if (!word) return
    if (startAtRef.current === null) startAtRef.current = Date.now()
    try {
      const data = await postJson<{ ok: boolean; error?: string }>('/api/validate', {
        start: pair.start,
        end: pair.end,
        path,
        word,
      })
      if (!data.ok) {
        setError(data.error ?? 'Not in dictionary')
        setShakeNonce((n) => n + 1)
        return
      }
      setError(null)
      setInput('')
      const nextPath = [...path, word]
      setPath(nextPath)
      if (word === pair.end) {
        await finishPath(nextPath)
      }
      focusInput()
    } catch {
      setError('Could not reach the server — try again.')
      setShakeNonce((n) => n + 1)
    }
  }

  async function useHint() {
    if (!pair || phase !== 'playing' || hintBusy) return
    const current = path[path.length - 1]
    if (current === pair.end) return
    setHintBusy(true)
    try {
      const data = await postJson<{ next: string | null }>('/api/hint', {
        start: pair.start,
        end: pair.end,
        current,
      })
      if (!data.next) {
        setError('No hint available from here.')
        setShakeNonce((n) => n + 1)
        return
      }
      if (startAtRef.current === null) startAtRef.current = Date.now()
      setError(null)
      setHintsUsed((n) => n + 1)
      const nextPath = [...path, data.next]
      setPath(nextPath)
      if (data.next === pair.end) {
        await finishPath(nextPath)
      }
      focusInput()
    } finally {
      setHintBusy(false)
    }
  }

  async function giveUp() {
    if (!pair || phase !== 'playing') return
    try {
      const data = await postJson<{ par: number; optimalPath: string[] }>('/api/giveup', {
        start: pair.start,
        end: pair.end,
      })
      setPhase('finished')
      setResult({
        steps: path.length - 1,
        par: data.par,
        optimalPath: data.optimalPath,
        isPar: false,
        gaveUp: true,
      })
    } catch {
      setError('Could not reach the server.')
      setShakeNonce((n) => n + 1)
    }
  }

  function playAgain() {
    setResult(null)
    setPendingFinish(null)
    setError(null)
    setInput('')
    setHintsUsed(0)
    setElapsed(0)
    startAtRef.current = null
    setPhase('playing')
    if (mode === 'practice') {
      void loadPractice()
    } else if (daily) {
      setPath([daily.start])
    }
    focusInput()
  }

  function switchMode(next: 'daily' | 'practice') {
    if (next === mode) return
    setMode(next)
    setPhase('playing')
    setResult(null)
    setPendingFinish(null)
    setError(null)
    setInput('')
    setHintsUsed(0)
    setElapsed(0)
    startAtRef.current = null
    if (next === 'practice') {
      void loadPractice()
    } else if (daily) {
      setPath([daily.start])
    }
    focusInput()
  }

  async function shareResult() {
    if (!daily || !result || result.gaveUp) return
    const squares = '🟩'.repeat(Math.max(1, result.steps))
    const text =
      `Ladder #${daily.number} — ${result.steps} steps (par ${result.par})${result.isPar ? ' ⭐' : ''}\n${squares}`
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = text
      document.body.appendChild(ta)
      ta.select()
      try {
        document.execCommand('copy')
        setCopied(true)
      } catch {
        // Clipboard unavailable — the text is shown in the result panel.
      }
      document.body.removeChild(ta)
    }
    setTimeout(() => setCopied(false), 2000)
  }

  const parRate =
    stats.played > 0 ? Math.round((stats.parHits / stats.played) * 100) : 0
  const solvingNow = mode === 'daily' && connected ? peers.length + 1 : null

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8">
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <h1 className="text-3xl font-bold tracking-tight text-foreground">Ladder</h1>
        {daily && mode === 'daily' && (
          <span className="text-sm text-muted-foreground">
            #{daily.number} · {daily.date}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <div
            className="flex rounded-full border border-border p-0.5 text-sm"
            role="tablist"
            aria-label="Game mode"
          >
            <button
              role="tab"
              aria-selected={mode === 'daily'}
              onClick={() => switchMode('daily')}
              className={
                mode === 'daily'
                  ? 'rounded-full bg-primary px-3 py-1 font-medium text-primary-foreground'
                  : 'rounded-full px-3 py-1 text-muted-foreground hover:text-foreground'
              }
            >
              Daily
            </button>
            <button
              role="tab"
              aria-selected={mode === 'practice'}
              onClick={() => switchMode('practice')}
              className={
                mode === 'practice'
                  ? 'rounded-full bg-primary px-3 py-1 font-medium text-primary-foreground'
                  : 'rounded-full px-3 py-1 text-muted-foreground hover:text-foreground'
              }
            >
              Practice
            </button>
          </div>
          <Button variant="outline" size="sm" onClick={() => setShowHood(true)}>
            Under the Hood
          </Button>
        </div>
      </div>

      {solvingNow !== null && (
        <p className="mb-4 text-sm text-muted-foreground">
          <span className="mr-1.5 inline-block h-2 w-2 rounded-full bg-emerald-500 align-middle" />
          {solvingNow} {solvingNow === 1 ? 'person' : 'people'} solving now
        </p>
      )}

      {loadError && (
        <div className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-foreground">
          {loadError}
          <Button variant="outline" size="sm" className="ml-3" onClick={() => (mode === 'daily' ? void loadDaily() : void loadPractice())}>
            Retry
          </Button>
        </div>
      )}

      {!pair && !loadError && (
        <p className="text-muted-foreground">Loading today’s ladder…</p>
      )}

      {pair && (
        <div className="grid gap-6 md:grid-cols-[1fr_240px]">
          <div>
            <p className="mb-3 text-sm text-muted-foreground">
              Turn <span className="font-mono font-bold text-foreground">{start.toUpperCase()}</span> into{' '}
              <span className="font-mono font-bold text-foreground">{end.toUpperCase()}</span>, one
              letter at a time. Every step must be a real word.
            </p>

            {/* The ladder stack */}
            <ol className="space-y-1.5" aria-label="Your ladder">
              {path.map((word, i) => {
                const changed = i === 0 ? -1 : diffIndex(path[i - 1], word)
                const isLast = i === path.length - 1
                const rewindable = phase === 'playing' && i < path.length - 1 && i > 0
                return (
                  <li key={`${i}-${word}`}>
                    <button
                      type="button"
                      disabled={!rewindable}
                      onClick={() => rewindable && setPath(path.slice(0, i + 1))}
                      title={rewindable ? 'Click to rewind to here' : undefined}
                      className={`flex w-full items-center gap-1 ${rewindable ? 'cursor-pointer opacity-80 hover:opacity-100' : 'cursor-default'}`}
                    >
                      <span className="w-6 text-right text-xs text-muted-foreground">{i}</span>
                      <span className="flex gap-1">
                        {word.split('').map((ch, j) => (
                          <span
                            key={j}
                            className={`flex h-10 w-10 items-center justify-center rounded-md border text-lg font-bold uppercase ${
                              j === changed
                                ? 'border-primary bg-primary text-primary-foreground'
                                : isLast
                                  ? 'border-border bg-card text-foreground'
                                  : 'border-border bg-muted/50 text-muted-foreground'
                            }`}
                          >
                            {ch}
                          </span>
                        ))}
                      </span>
                      {rewindable && (
                        <span className="ml-2 text-xs text-muted-foreground">↩ rewind</span>
                      )}
                    </button>
                  </li>
                )
              })}
              {/* Goal row */}
              <li className="flex items-center gap-1 opacity-60">
                <span className="w-6 text-right text-xs text-muted-foreground">→</span>
                <span className="flex gap-1">
                  {end.split('').map((ch, j) => (
                    <span
                      key={j}
                      className="flex h-10 w-10 items-center justify-center rounded-md border border-dashed border-border text-lg font-bold uppercase text-muted-foreground"
                    >
                      {ch}
                    </span>
                  ))}
                </span>
                <span className="ml-2 text-xs text-muted-foreground">goal</span>
              </li>
            </ol>

            {phase === 'playing' && (
              <div className="mt-5">
                <div className="flex gap-2">
                  <Input
                    ref={inputRef}
                    autoFocus
                    value={input}
                    onChange={(e) => setInput(e.target.value.replace(/[^a-zA-Z]/g, '').slice(0, 4))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        void submitWord()
                      } else if (
                        e.key === 'Backspace' &&
                        input === '' &&
                        path.length > 1
                      ) {
                        e.preventDefault()
                        setPath(path.slice(0, -1))
                        setError(null)
                      }
                    }}
                    placeholder="Next word"
                    autoCapitalize="off"
                    autoComplete="off"
                    autoCorrect="off"
                    spellCheck={false}
                    aria-label="Next word in the ladder"
                    className="h-11 flex-1 font-mono text-lg uppercase tracking-[0.3em]"
                  />
                  <Button onClick={() => void submitWord()} className="h-11">
                    Add
                  </Button>
                </div>
                <div
                  key={shakeNonce}
                  className={error ? 'animate-shake mt-2 text-sm font-medium text-destructive' : 'mt-2 text-sm text-muted-foreground'}
                  role={error ? 'alert' : undefined}
                >
                  {error ?? (
                    <>
                      Enter submits · Backspace on empty pops the last rung · click a rung to
                      rewind · {formatTime(elapsed)}
                      {hintsUsed > 0 ? ` · ${hintsUsed} hint${hintsUsed === 1 ? '' : 's'} used (no par)` : ''}
                    </>
                  )}
                </div>
                <div className="mt-3 flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => void useHint()} disabled={hintBusy}>
                    Hint
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => void giveUp()}>
                    Give up
                  </Button>
                </div>
              </div>
            )}

            {phase === 'finished' && result && (
              <div className="mt-6 rounded-lg border border-border bg-card p-5">
                {result.gaveUp ? (
                  <>
                    <h2 className="text-lg font-semibold text-foreground">You gave up</h2>
                    <p className="mt-1 text-sm text-muted-foreground">
                      The par was {result.par} steps. Here’s one shortest path — try the daily
                      again or jump into practice.
                    </p>
                  </>
                ) : (
                  <>
                    <h2 className="text-lg font-semibold text-foreground">
                      Solved in {result.steps} steps{' '}
                      <span className="text-muted-foreground">(par {result.par})</span>
                      {result.isPar && (
                        <span className="ml-2 rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-bold text-emerald-600">
                          PAR ⭐
                        </span>
                      )}
                    </h2>
                    {mode === 'daily' && result.rank !== undefined && (
                      <p className="mt-1 text-sm text-muted-foreground">
                        #{result.rank} of {result.total} on today’s board
                        {result.isBest ? ' · new personal best' : ''}
                      </p>
                    )}
                  </>
                )}
                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  <div>
                    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Your path
                    </h3>
                    <ol className="space-y-0.5 font-mono text-sm">
                      {path.map((w, i) => (
                        <li key={i} className={i === 0 ? 'text-muted-foreground' : 'text-foreground'}>
                          {i}. {w.toUpperCase()}
                        </li>
                      ))}
                    </ol>
                  </div>
                  <div>
                    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      One optimal path
                    </h3>
                    <ol className="space-y-0.5 font-mono text-sm">
                      {result.optimalPath.map((w, i) => (
                        <li key={i} className="text-foreground">
                          {i}. {w.toUpperCase()}
                        </li>
                      ))}
                    </ol>
                  </div>
                </div>
                {mode === 'daily' && !result.gaveUp && (
                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    <Button onClick={() => void shareResult()} disabled={saving}>
                      {copied ? 'Copied!' : 'Share'}
                    </Button>
                    <Button variant="outline" onClick={playAgain}>
                      Play again
                    </Button>
                  </div>
                )}
                {mode === 'practice' && (
                  <div className="mt-4">
                    <Button onClick={playAgain}>Another practice ladder</Button>
                  </div>
                )}
                {result.gaveUp && (
                  <div className="mt-4">
                    <Button onClick={playAgain}>Try again</Button>
                  </div>
                )}
              </div>
            )}

            {phase === 'finished' && !result && pendingFinish && mode === 'daily' && (
              <div className="mt-6 rounded-lg border border-border bg-card p-5">
                <h2 className="text-lg font-semibold text-foreground">
                  Solved in {path.length - 1} steps!
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Pick a display name to save your score to today’s leaderboard.
                </p>
                <div className="mt-3 flex gap-2">
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value.slice(0, 20))}
                    placeholder="Your name"
                    aria-label="Display name"
                    maxLength={20}
                    className="h-10 flex-1"
                  />
                  <Button onClick={() => void saveWithName()} disabled={saving || !name.trim()}>
                    {saving ? 'Saving…' : 'Save score'}
                  </Button>
                </div>
              </div>
            )}
          </div>

          {/* Sidebar: stats + leaderboard */}
          <aside className="space-y-6">
            <div className="rounded-lg border border-border bg-card p-4">
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Your stats
              </h2>
              <dl className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <dt className="text-muted-foreground">Streak</dt>
                  <dd className="text-lg font-bold text-foreground">{stats.streak} 🔥</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Best streak</dt>
                  <dd className="text-lg font-bold text-foreground">{stats.maxStreak}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Days played</dt>
                  <dd className="text-lg font-bold text-foreground">{stats.played}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Par rate</dt>
                  <dd className="text-lg font-bold text-foreground">{parRate}%</dd>
                </div>
              </dl>
              <label className="mt-4 block text-xs font-medium text-muted-foreground">
                Display name (for the leaderboard)
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value.slice(0, 20))}
                  placeholder="e.g. Maya"
                  maxLength={20}
                  className="mt-1 h-9"
                />
              </label>
            </div>

            <div className="rounded-lg border border-border bg-card p-4">
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Today’s board
              </h2>
              {!board ? (
                <p className="text-sm text-muted-foreground">Loading…</p>
              ) : board.length === 0 ? (
                <p className="text-sm text-muted-foreground">No scores yet — be the first.</p>
              ) : (
                <ol className="space-y-1.5 text-sm">
                  {board.slice(0, 10).map((entry, i) => {
                    const mine = savedName !== null && entry.name === savedName
                    return (
                      <li
                        key={`${entry.name}-${i}`}
                        className={`flex items-baseline gap-2 rounded px-1.5 py-0.5 ${
                          mine ? 'bg-primary/10 font-semibold text-foreground' : 'text-foreground'
                        }`}
                      >
                        <span className="w-5 text-muted-foreground">{i + 1}.</span>
                        <span className="flex-1 truncate">{entry.name}</span>
                        <span className="text-muted-foreground">
                          {entry.steps} steps · {formatTime(entry.seconds)}
                        </span>
                      </li>
                    )
                  })}
                </ol>
              )}
            </div>
          </aside>
        </div>
      )}

      <Modal open={showHood} onClose={() => setShowHood(false)} size="lg">
        <Modal.Header>
          <Modal.Title>Under the Hood</Modal.Title>
          <Modal.Description>How Ladder works — no magic, just a graph and a search.</Modal.Description>
        </Modal.Header>
        <Modal.Body>
          <div className="space-y-3 text-sm text-muted-foreground">
            <p>
              <strong className="text-foreground">The graph.</strong> Every valid 4-letter word is
              a node. Two words are connected when they differ by exactly one letter. Instead of
              comparing every pair, the server buckets words by wildcard pattern — COLD lives in
              the buckets <code className="font-mono text-foreground">_OLD</code>,{' '}
              <code className="font-mono text-foreground">C_LD</code>,{' '}
              <code className="font-mono text-foreground">CO_D</code> and{' '}
              <code className="font-mono text-foreground">COL_</code> — so its neighbours are just
              the other words sharing a bucket. That turns a 7,000-word graph into a hash lookup.
            </p>
            <p>
              <strong className="text-foreground">The par.</strong> A breadth-first search from the
              start word finds the shortest path to the end word, and counts how many distinct
              shortest paths exist. The daily puzzle is only shipped if its par is 4–6 steps with
              at least two shortest paths, so there is never a single forced line. The par and the
              optimal path are computed on the server and revealed only after you finish or give
              up — your browser never sees them early.
            </p>
            <p>
              <strong className="text-foreground">The daily.</strong> The puzzle for a UTC date is
              deterministic: Ladder #N uses pair (N−1) mod 90 from a bank of 90 pre-validated pairs,
              so everyone in the world gets the same ladder and the board is comparable.
            </p>
            <p>
              <strong className="text-foreground">The board.</strong> Scores are validated
              server-side (every rung checked against the dictionary and the one-letter rule) and
              kept per (date, name) — unlimited retries, best result counts. The board is seeded
              each morning with deterministic placeholder entries so it never looks empty on day
              one.
            </p>
          </div>
        </Modal.Body>
      </Modal>
    </div>
  )
}
