/**
 * Ladder — the game page.
 *
 * Public: no sign-in anywhere. It lives under (app)/ for the data layer
 * (presence) but outside (protected)/, so anonymous visitors play the
 * daily freely. Personal stats live in localStorage; scores reach the
 * worker's public routes, which validate everything server-side.
 *
 * Bot mode imports the engine (src/lib/ladder.ts) into the browser: the
 * bot's path is simulated client-side from the same solver the server
 * uses. Bot mode has no leaderboard, so there is nothing to cheat for —
 * but it does mean the solver ships in the client bundle. The daily
 * game still validates every step server-side, and the par is only ever
 * revealed after a finish or a forfeit.
 *
 * THE LOCK RULE: the letter position changed in one rung is locked for
 * the next rung only. The just-changed position shows a lock on the
 * current rung, and a step that changes it is rejected (server-side,
 * with an instant client-side pre-check for feedback).
 *
 * SOLVED LOCKS THE DAY: once the daily is solved, the solve (name, steps,
 * time, path, par) is recorded in localStorage (ladder-solved-v1) and
 * revisiting shows the Solved state instead of a fresh board — no replay
 * until tomorrow. The name is locked per date the same way. This is
 * per-browser enforcement, not per-person: the server still upserts per
 * (date, name) and cannot bind a browser to a name.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { usePresenceRoom } from 'deepspace'
import { Lock } from 'lucide-react'
import { Button, Input } from '@/components/ui'
import {
  bfs,
  diffIndex,
  GUESS_BUCKETS,
  preferredPath,
  wanderingPath,
} from '@/lib/ladder'
import {
  loadSolvedBook,
  recordSolved,
  saveSolvedBook,
  solvedFor,
  type SolvedEntry,
} from '@/lib/solved'

type Mode = 'daily' | 'practice' | 'bot'

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

interface BotResult {
  winner: 'you' | 'bot'
  playerSteps: number
  playerSeconds: number
  botSteps: number
  botSeconds: number
  par: number
  gaveUp: boolean
  // Only what the bot actually walked: if you won, this stops at the bot's
  // current word — its planned route stays hidden.
  botPath: string[]
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

/** Bot difficulties: how fast the bot moves, and how optimal its line is. */
const BOT_LEVELS = {
  elementary: {
    label: 'Elementary',
    delayMin: 6000,
    delayMax: 9000,
    greediness: 0.45,
    blurb: 'Slow and wandering — takes the scenic route. A gentle first race.',
  },
  middle: {
    label: 'Middle',
    delayMin: 5000,
    delayMax: 7000,
    greediness: 0.7,
    blurb: 'Takes its time and wanders a little — a thinking human has a real chance.',
  },
  high: {
    label: 'High',
    delayMin: 3000,
    delayMax: 4000,
    greediness: 1,
    blurb: 'Plays the optimal path, but at a human pace. A fast, accurate run can edge it out.',
  },
} as const

type BotDifficulty = keyof typeof BOT_LEVELS

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

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return (await res.json()) as T
}

export default function PlayPage() {
  const [mode, setMode] = useState<Mode>('daily')
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
  // Today's solve, when this browser already solved the daily. Solved locks
  // the day — the board is not replayable until tomorrow.
  const [solvedToday, setSolvedToday] = useState<SolvedEntry | null>(null)
  const [saving, setSaving] = useState(false)
  const [board, setBoard] = useState<BoardEntry[] | null>(null)
  const [stats, setStats] = useState<Stats>(loadStats)
  const [elapsed, setElapsed] = useState(0)
  const [copied, setCopied] = useState(false)
  const startAtRef = useRef<number | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // --- Bot mode -------------------------------------------------------------
  const [botDifficulty, setBotDifficulty] = useState<BotDifficulty | null>(null)
  const [botPair, setBotPair] = useState<{ start: string; end: string } | null>(null)
  const [botPath, setBotPath] = useState<string[]>([])
  const [botIndex, setBotIndex] = useState(0)
  const [botDistLeft, setBotDistLeft] = useState<number | null>(null)
  const [botResult, setBotResult] = useState<BotResult | null>(null)
  const [botLoading, setBotLoading] = useState(false)
  // Refs are the race's source of truth: timeout callbacks must see the
  // latest values, not the render scope they were scheduled from.
  const botTimerRef = useRef<number | null>(null)
  const botPathRef = useRef<string[]>([])
  const botIndexRef = useRef(0)
  const botPairRef = useRef<{ start: string; end: string } | null>(null)
  const botDifficultyRef = useRef<BotDifficulty | null>(null)
  const botStartedAtRef = useRef<number | null>(null)
  const botFinishedRef = useRef(false)
  const playerFinishedRef = useRef(false)
  // The player's current path, mirrored for timeout callbacks (the bot
  // wins from inside a timer, where the render scope's `path` is stale).
  const playerPathRef = useRef<string[]>([])
  useEffect(() => {
    playerPathRef.current = path
  }, [path])

  const pair = mode === 'daily' ? daily : mode === 'practice' ? practicePair : botPair
  const start = pair?.start ?? ''
  const end = pair?.end ?? ''

  // The position locked for the next rung: the one changed on the last step.
  const prevWord = path.length > 0 ? path[path.length - 1] : ''
  const lockedPos =
    path.length >= 2 ? diffIndex(path[path.length - 2], prevWord) : -1

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

  // Enter today's daily: a fresh board, unless this browser already solved
  // it — then restore the Solved state (no replay; the day is done).
  function restoreDaily(date: string, start: string) {
    const solved = solvedFor(loadSolvedBook(), date)
    setPendingFinish(null)
    setError(null)
    setInput('')
    setHintsUsed(0)
    setElapsed(0)
    startAtRef.current = null
    if (solved) {
      setSolvedToday(solved)
      setSavedName(solved.name)
      setPath(solved.path)
      setPhase('finished')
      setResult({
        steps: solved.steps,
        par: solved.par,
        optimalPath: solved.optimalPath,
        isPar: solved.isPar,
        gaveUp: false,
      })
    } else {
      setSolvedToday(null)
      setPath([start])
      setPhase('playing')
      setResult(null)
    }
  }

  const loadDaily = useCallback(async () => {
    setLoadError(null)
    try {
      const res = await fetch('/api/daily')
      const data = (await res.json()) as DailyInfo
      setDaily(data)
      restoreDaily(data.date, data.start)
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

  // Never leave a bot timer running after unmount.
  useEffect(() => {
    return () => {
      if (botTimerRef.current !== null) {
        clearTimeout(botTimerRef.current)
        botTimerRef.current = null
      }
    }
  }, [])

  const focusInput = () => inputRef.current?.focus()

  function clearBotTimer() {
    if (botTimerRef.current !== null) {
      clearTimeout(botTimerRef.current)
      botTimerRef.current = null
    }
  }

  function resetBotRound() {
    clearBotTimer()
    botPathRef.current = []
    botIndexRef.current = 0
    botPairRef.current = null
    botDifficultyRef.current = null
    botStartedAtRef.current = null
    botFinishedRef.current = false
    playerFinishedRef.current = false
    setBotPair(null)
    setBotPath([])
    setBotIndex(0)
    setBotDistLeft(null)
    setBotResult(null)
    setBotDifficulty(null)
    setBotLoading(false)
  }

  function randomBotDelay(cfg: (typeof BOT_LEVELS)[BotDifficulty]): number {
    return cfg.delayMin + Math.random() * (cfg.delayMax - cfg.delayMin)
  }

  function scheduleBotStep(delayMs: number) {
    clearBotTimer()
    botTimerRef.current = window.setTimeout(() => {
      botTimerRef.current = null
      advanceBot()
    }, delayMs)
  }

  function advanceBot() {
    const pair = botPairRef.current
    const path = botPathRef.current
    const difficulty = botDifficultyRef.current
    if (!pair || !difficulty || path.length < 2) return
    if (botFinishedRef.current || playerFinishedRef.current) return
    const nextIndex = botIndexRef.current + 1
    if (nextIndex >= path.length) {
      finishBotRound('bot', playerPathRef.current)
      return
    }
    botIndexRef.current = nextIndex
    setBotIndex(nextIndex)
    const word = path[nextIndex]
    const locked = diffIndex(path[nextIndex - 1], word)
    const remaining = bfs(word, pair.end, GUESS_BUCKETS, 3, locked).dist
    setBotDistLeft(remaining < 0 ? 0 : remaining)
    if (word === pair.end) {
      finishBotRound('bot', playerPathRef.current)
      return
    }
    scheduleBotStep(randomBotDelay(BOT_LEVELS[difficulty]))
  }

  function finishBotRound(winner: 'you' | 'bot', playerPath: string[], gaveUp = false) {
    clearBotTimer()
    const now = Date.now()
    const playerSeconds =
      startAtRef.current === null ? 0 : Math.floor((now - startAtRef.current) / 1000)
    const botSeconds =
      botStartedAtRef.current === null
        ? 0
        : Math.floor((now - botStartedAtRef.current) / 1000)
    const pair = botPairRef.current
    const par = pair ? bfs(pair.start, pair.end).dist : 0
    if (winner === 'you') playerFinishedRef.current = true
    else botFinishedRef.current = true
    setBotResult({
      winner,
      playerSteps: playerPath.length - 1,
      playerSeconds,
      botSteps: botIndexRef.current,
      botSeconds,
      par,
      gaveUp,
      // Only what the bot actually walked: if you won, the shown path stops
      // at the bot's current word — its planned route stays hidden. When
      // the bot reaches the target, the walked path is the full path.
      botPath: botPathRef.current.slice(0, botIndexRef.current + 1),
    })
    setPhase('finished')
  }

  async function startBotRound(difficulty: BotDifficulty) {
    clearBotTimer()
    setLoadError(null)
    setBotLoading(true)
    setBotResult(null)
    setResult(null)
    setPendingFinish(null)
    setError(null)
    setInput('')
    setHintsUsed(0)
    setElapsed(0)
    startAtRef.current = null
    setPhase('playing')
    playerFinishedRef.current = false
    botFinishedRef.current = false
    try {
      const res = await fetch('/api/practice')
      const data = (await res.json()) as { start: string; end: string }
      const cfg = BOT_LEVELS[difficulty]
      const optimal = preferredPath(data.start, data.end)
      const line =
        difficulty === 'high'
          ? optimal
          : (wanderingPath(data.start, data.end, { greediness: cfg.greediness }) ??
            optimal)
      if (!line || line.length < 2) {
        setLoadError('Could not build a bot ladder. Try again.')
        setBotLoading(false)
        return
      }
      botPathRef.current = line
      botIndexRef.current = 0
      botPairRef.current = data
      botDifficultyRef.current = difficulty
      botStartedAtRef.current = Date.now()
      setBotDifficulty(difficulty)
      setBotPair(data)
      setBotPath(line)
      setBotIndex(0)
      setBotDistLeft(bfs(data.start, data.end).dist)
      setPath([data.start])
      setBotLoading(false)
      scheduleBotStep(randomBotDelay(cfg))
      focusInput()
    } catch {
      setBotLoading(false)
      setLoadError('Could not load a bot ladder. Check your connection and try again.')
    }
  }

  function showBotPicker() {
    clearBotTimer()
    resetBotRound()
    setPhase('playing')
    setResult(null)
    setPendingFinish(null)
    setError(null)
    setInput('')
    focusInput()
  }

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
      // Solved locks the day: record the solve (and the name) locally so
      // revisiting shows the Solved state instead of a fresh board.
      const entry: SolvedEntry = {
        name: playerName,
        steps: data.steps,
        seconds,
        path: [...finalPath],
        par: data.par,
        isPar: data.isPar,
        optimalPath: data.optimalPath,
      }
      saveSolvedBook(recordSolved(loadSolvedBook(), daily.date, entry))
      setSolvedToday(entry)
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
    // Bot mode: reaching the end first wins the race — no server scoring.
    if (mode === 'bot') {
      if (!botFinishedRef.current) finishBotRound('you', finalPath)
      return
    }
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
    // Instant lock feedback client-side (the server re-checks on /api/validate).
    if (lockedPos !== -1 && diffIndex(prevWord, word) === lockedPos) {
      setError("That letter's locked for this rung")
      setShakeNonce((n) => n + 1)
      return
    }
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

  async function requestHint() {
    if (!pair || phase !== 'playing' || hintBusy || mode !== 'practice') return
    const current = path[path.length - 1]
    if (current === pair.end) return
    setHintBusy(true)
    try {
      const data = await postJson<{ next: string | null }>('/api/hint', {
        start: pair.start,
        end: pair.end,
        current,
        path,
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
    // Bot mode: giving up forfeits the race to the bot.
    if (mode === 'bot') {
      finishBotRound('bot', path, true)
      return
    }
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
    if (mode === 'bot') {
      if (botDifficultyRef.current) void startBotRound(botDifficultyRef.current)
      else showBotPicker()
      return
    }
    if (mode === 'practice') {
      void loadPractice()
    } else if (daily) {
      setPath([daily.start])
    }
    focusInput()
  }

  function switchMode(next: Mode) {
    if (next === mode) return
    clearBotTimer()
    resetBotRound()
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
    } else if (next === 'daily' && daily) {
      restoreDaily(daily.date, daily.start)
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
  const botWord = botPath.length > 0 ? botPath[Math.min(botIndex, botPath.length - 1)] : ''
  const botPrevWord = botIndex > 0 && botPath.length > 0 ? botPath[botIndex - 1] : ''
  const botChanged = botPrevWord ? diffIndex(botPrevWord, botWord) : -1

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8">
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <h1 className="text-3xl font-bold tracking-tight text-foreground">Ladder</h1>
        {daily && mode === 'daily' && (
          <span className="text-sm text-muted-foreground">
            #{daily.number} · {daily.date}
          </span>
        )}
        {daily && mode === 'daily' && solvedToday && (
          <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-bold text-emerald-600">
            ✓ Solved
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
            <button
              role="tab"
              aria-selected={mode === 'bot'}
              onClick={() => switchMode('bot')}
              className={
                mode === 'bot'
                  ? 'rounded-full bg-primary px-3 py-1 font-medium text-primary-foreground'
                  : 'rounded-full px-3 py-1 text-muted-foreground hover:text-foreground'
              }
            >
              Bot
            </button>
          </div>
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
          <Button variant="outline" size="sm" className="ml-3" onClick={() => (mode === 'daily' ? void loadDaily() : mode === 'practice' ? void loadPractice() : botDifficultyRef.current ? void startBotRound(botDifficultyRef.current) : showBotPicker())}>
            Retry
          </Button>
        </div>
      )}

      {/* Bot mode: difficulty picker (no round yet) */}
      {mode === 'bot' && botPair === null && !botLoading && (
        <div className="rounded-lg border border-border bg-card p-5">
          <h2 className="text-lg font-semibold text-foreground">Race the bot</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Same start word, same target — first one there wins. Each race is a new random
            ladder. Pick a difficulty:
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            {(['elementary', 'middle', 'high'] as const).map((level) => (
              <button
                key={level}
                type="button"
                onClick={() => void startBotRound(level)}
                className={`rounded-lg border p-4 text-left transition-colors hover:border-primary ${
                  botDifficulty === level ? 'border-primary bg-primary/5' : 'border-border bg-background'
                }`}
              >
                <span className="block text-base font-semibold text-foreground">
                  {BOT_LEVELS[level].label}
                </span>
                <span className="mt-1 block text-sm text-muted-foreground">
                  {BOT_LEVELS[level].blurb}
                </span>
                <span className="mt-3 block text-sm font-medium text-primary">Race →</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {mode === 'bot' && botLoading && (
        <p className="text-muted-foreground">Loading your race…</p>
      )}

      {!pair && !loadError && mode !== 'bot' && (
        <p className="text-muted-foreground">Loading today’s ladder…</p>
      )}

      {pair && !botLoading && (
        <div className="grid gap-6 md:grid-cols-[1fr_240px]">
          <div>
            <p className="mb-3 text-sm text-muted-foreground">
              Turn <span className="font-mono font-bold text-foreground">{start.toUpperCase()}</span> into{' '}
              <span className="font-mono font-bold text-foreground">{end.toUpperCase()}</span>, one
              letter at a time. Every step must be a real word.
              {mode === 'bot' && ' Beat the bot there.'}
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
                            className={`relative flex h-10 w-10 items-center justify-center rounded-md border text-lg font-bold uppercase ${
                              j === changed
                                ? 'border-primary bg-primary text-primary-foreground'
                                : isLast
                                  ? 'border-border bg-card text-foreground'
                                  : 'border-border bg-muted/50 text-muted-foreground'
                            }`}
                          >
                            {ch}
                            {isLast && j === changed && (
                              <span
                                className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-amber-400 text-amber-950"
                                title="Locked for the next rung"
                              >
                                <Lock className="h-2.5 w-2.5" strokeWidth={3} />
                              </span>
                            )}
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
                {lockedPos !== -1 && !error && (
                  <p className="mt-2 flex items-center gap-1.5 text-xs font-medium text-amber-600">
                    <Lock className="h-3 w-3" />
                    Letter {lockedPos + 1} ({prevWord[lockedPos].toUpperCase()}) is locked for
                    this rung — your next word must keep it.
                  </p>
                )}
                <div className="mt-3 flex gap-2">
                  {mode === 'practice' && (
                    <Button variant="outline" size="sm" onClick={() => void requestHint()} disabled={hintBusy}>
                      Hint
                    </Button>
                  )}
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
                    <span className="text-sm text-muted-foreground">
                      Solved — come back tomorrow for a new ladder.
                    </span>
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

            {phase === 'finished' && mode === 'bot' && botResult && (
              <div className="mt-6 rounded-lg border border-border bg-card p-5">
                <h2 className="text-lg font-semibold text-foreground">
                  {botResult.winner === 'you'
                    ? 'You beat the bot! 🎉'
                    : botResult.gaveUp
                      ? 'You gave up — the bot wins'
                      : 'The bot beat you'}
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  You: {botResult.playerSteps} steps · {formatTime(botResult.playerSeconds)}
                  {' · '}Bot: {botResult.botSteps} steps · {formatTime(botResult.botSeconds)}
                  {' · '}Par {botResult.par}
                </p>
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
                      {botResult.winner === 'bot' && !botResult.gaveUp
                        ? 'Bot’s path'
                        : 'Bot’s path so far'}
                    </h3>
                    <ol className="space-y-0.5 font-mono text-sm">
                      {botResult.botPath.map((w, i) => (
                        <li key={i} className="text-foreground">
                          {i}. {w.toUpperCase()}
                        </li>
                      ))}
                    </ol>
                  </div>
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button onClick={playAgain}>Race again</Button>
                  <Button variant="outline" onClick={showBotPicker}>
                    Change difficulty
                  </Button>
                </div>
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

          {/* Sidebar */}
          <aside className="space-y-6">
            {mode === 'bot' ? (
              <div className="rounded-lg border border-border bg-card p-4">
                <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Bot · {botDifficulty ? BOT_LEVELS[botDifficulty].label : ''}
                </h2>
                {botWord && (
                  <>
                    <div className="flex gap-1">
                      {botWord.split('').map((ch, j) => (
                        <span
                          key={j}
                          className={`flex h-9 w-9 items-center justify-center rounded-md border text-base font-bold uppercase ${
                            j === botChanged
                              ? 'border-primary bg-primary text-primary-foreground'
                              : 'border-border bg-muted/50 text-foreground'
                          }`}
                        >
                          {ch}
                        </span>
                      ))}
                    </div>
                    <dl className="mt-3 space-y-1.5 text-sm">
                      <div className="flex justify-between">
                        <dt className="text-muted-foreground">Bot steps</dt>
                        <dd className="font-bold text-foreground">{botIndex}</dd>
                      </div>
                      <div className="flex justify-between">
                        <dt className="text-muted-foreground">Distance left</dt>
                        <dd className="font-bold text-foreground">
                          {botDistLeft === null ? '—' : `${botDistLeft} to go`}
                        </dd>
                      </div>
                    </dl>
                    {phase === 'playing' && (
                      <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
                        <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-emerald-500" />
                        Bot is thinking…
                      </p>
                    )}
                  </>
                )}
              </div>
            ) : (
              <>
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
                  {mode === 'daily' && solvedToday ? (
                    <p className="mt-4 text-xs text-muted-foreground">
                      Saved as{' '}
                      <span className="font-semibold text-foreground">{solvedToday.name}</span>
                      {' '}— your name is locked in for today.
                    </p>
                  ) : (
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
                  )}
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
              </>
            )}
          </aside>
        </div>
      )}
    </div>
  )
}
