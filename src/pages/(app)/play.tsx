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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePresenceRoom } from 'deepspace'
import { Lock, Search } from 'lucide-react'
import { Button, Input } from '@/components/ui'
import {
  bfs,
  bucketsForLength,
  diffIndex,
  preferredPath,
  setsForLength,
  wanderingPath,
} from '@/lib/ladder'
import {
  deriveMatch,
  DISCONNECT_GRACE_MS,
  OPPONENT_JOIN_TIMEOUT_MS,
  resolveVersus,
  SETTLE_MS,
  type QueueCandidate,
  type VersusMatch,
  type VersusSideState,
} from '@/lib/versus'
import {
  loadSolvedBook,
  recordSolved,
  saveSolvedBook,
  solvedFor,
  type SolvedEntry,
} from '@/lib/solved'

type Mode = 'daily' | 'practice' | 'bot' | 'versus'

/** What one side of a 1v1 match broadcasts (steps + distance only — never
 * the current word, and the path only after the match is resolved). */
interface VersusPeerWireState {
  name: string
  clientId: string
  status: 'playing' | 'finished' | 'gave-up' | 'done'
  steps: number
  /** Shortest distance left, or null when the end is unreachable from here. */
  distance: number | null
  finishMs?: number
  finishSteps?: number
  gaveUpMs?: number
  /** Only present once the match is resolved (the side-by-side reveal). */
  path?: string[]
}

interface VersusResult {
  winner: 'you' | 'opponent'
  reason: 'finish' | 'forfeit' | 'disconnect'
  mySteps: number
  mySeconds: number
  oppSteps: number | null
  oppSeconds: number | null
  oppName: string
  oppPath: string[] | null
}

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

/**
 * Per-mode identity: accent color + one-line flavor. All class strings are
 * full literals so Tailwind's scanner picks them up — do not build them
 * dynamically from the mode name.
 */
const MODE_STYLE = {
  daily: {
    label: 'Daily',
    flavor: 'Today’s shared ladder — one shot, then it’s done.',
    pillActive:
      'bg-emerald-500 text-white shadow-[0_2px_12px_rgba(16,185,129,0.45)]',
    pillHover: 'hover:text-emerald-400',
    accentText: 'text-emerald-500',
    bar: 'bg-emerald-500',
    changedTile:
      'border-emerald-400 bg-emerald-500 text-white shadow-[0_0_14px_rgba(16,185,129,0.45)]',
  },
  practice: {
    label: 'Practice',
    flavor: 'Endless ladders. Zero pressure.',
    pillActive: 'bg-sky-500 text-white shadow-[0_2px_12px_rgba(59,130,246,0.45)]',
    pillHover: 'hover:text-sky-400',
    accentText: 'text-sky-500',
    bar: 'bg-sky-500',
    changedTile:
      'border-sky-400 bg-sky-500 text-white shadow-[0_0_14px_rgba(59,130,246,0.45)]',
  },
  bot: {
    label: 'Bot',
    flavor: 'Race the bot — first to the target wins.',
    pillActive:
      'bg-violet-500 text-white shadow-[0_2px_12px_rgba(139,92,246,0.45)]',
    pillHover: 'hover:text-violet-400',
    accentText: 'text-violet-500',
    bar: 'bg-violet-500',
    changedTile:
      'border-violet-400 bg-violet-500 text-white shadow-[0_0_14px_rgba(139,92,246,0.45)]',
  },
  versus: {
    label: '1v1',
    flavor: 'Race a live opponent.',
    pillActive: 'bg-amber-500 text-white shadow-[0_2px_12px_rgba(245,158,11,0.45)]',
    pillHover: 'hover:text-amber-400',
    accentText: 'text-amber-500',
    bar: 'bg-amber-500',
    changedTile:
      'border-amber-400 bg-amber-500 text-white shadow-[0_0_14px_rgba(245,158,11,0.45)]',
  },
} as const

/** Thin progress bar (0..1) for distance-left / par-rate visuals. */
function MiniBar({ fraction, className }: { fraction: number; className: string }) {
  const pct = Math.max(0, Math.min(100, Math.round(fraction * 100)))
  return (
    <div className="h-2 overflow-hidden rounded-full bg-muted">
      <div
        className={`h-full rounded-full transition-all duration-500 ${className}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}

type WordLength = 4 | 5

/** 4 / 5-letter picker for Practice, Bot and 1v1 (Daily stays 4-letter).
 * `accent` is the mode's bar class (a full Tailwind literal). */
function LengthPicker({
  value,
  onChange,
  accent,
}: {
  value: WordLength
  onChange: (len: WordLength) => void
  accent: string
}) {
  return (
    <div className="flex items-center gap-1.5" role="group" aria-label="Word length">
      <span className="mr-1 text-xs font-medium text-muted-foreground">Word length</span>
      {([4, 5] as const).map((len) => (
        <button
          key={len}
          type="button"
          onClick={() => onChange(len)}
          aria-pressed={value === len}
          className={
            value === len
              ? `rounded-full px-2.5 py-1 text-xs font-bold text-white transition-all hover:scale-[1.04] active:scale-95 ${accent}`
              : 'rounded-full px-2.5 py-1 text-xs font-medium text-muted-foreground transition-all hover:scale-[1.04] hover:text-foreground active:scale-95'
          }
        >
          {len} letters
        </button>
      ))}
    </div>
  )
}

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

/**
 * Brisk staggered reveal — the first row shows at once, the rest appear
 * one every ~300ms, so the player registers the line without sitting
 * through a slow animation. Used for the bot's path and the 1v1
 * opponent's path in the end-of-round panels.
 */
function RevealList({ words }: { words: string[] }) {
  const key = words.join(',')
  const [shown, setShown] = useState(1)
  useEffect(() => {
    setShown(1)
  }, [key])
  useEffect(() => {
    if (shown >= words.length) return
    const id = window.setTimeout(
      () => setShown((n) => Math.min(n + 1, words.length)),
      300,
    )
    return () => window.clearTimeout(id)
  }, [shown, words.length])
  return (
    <ol className="space-y-0.5 font-mono text-sm">
      {words.slice(0, shown).map((w, i) => (
        <li key={i} className="text-foreground">
          {i}. {w.toUpperCase()}
        </li>
      ))}
    </ol>
  )
}

// --- 1v1 presence clients -------------------------------------------------
// These are separate components so their usePresenceRoom hooks only connect
// while the stage needs them: mounting the queue client joins the queue,
// unmounting it leaves. The match client likewise.

interface VersusQueueWireState {
  name: string
  clientId: string
  queuedAt: number
  length: 4 | 5
}

function VersusQueueClient({
  clientId,
  name,
  queuedAt,
  length,
  onMatched,
  onCount,
}: {
  clientId: string
  name: string
  queuedAt: number
  length: 4 | 5
  onMatched: (match: VersusMatch) => void
  onCount: (count: number) => void
}) {
  // One queue room per word length, so a 4-letter player can never be
  // matched with a 5-letter one.
  const { peers, connected, updateState } = usePresenceRoom(`ladder:1v1-queue-${length}`)
  const updateRef = useRef(updateState)
  updateRef.current = updateState
  const matchedRef = useRef(false)
  const onMatchedRef = useRef(onMatched)
  onMatchedRef.current = onMatched
  const onCountRef = useRef(onCount)
  onCountRef.current = onCount

  // Publish our queue entry (re-publish on connect, in case the socket
  // was not up yet on mount).
  useEffect(() => {
    updateRef.current({ vsQueue: { name, clientId, queuedAt, length } })
  }, [connected, name, clientId, queuedAt, length])

  useEffect(() => {
    const candidates: QueueCandidate[] = [
      { clientId, name, queuedAt, length },
      ...peers.flatMap((p): QueueCandidate[] => {
        const q = (p.state as Record<string, unknown> | undefined)?.vsQueue as
          | VersusQueueWireState
          | undefined
        return q && typeof q.clientId === 'string' && typeof q.queuedAt === 'number'
          ? [
              {
                clientId: q.clientId,
                name: String(q.name ?? 'Player'),
                queuedAt: q.queuedAt,
                // Peers from an older build carry no length — they are
                // 4-letter players by definition.
                length: q.length === 5 ? 5 : 4,
              },
            ]
          : []
      }),
    ]
    onCountRef.current(candidates.length)
    if (matchedRef.current) return
    const match = deriveMatch(candidates)
    if (
      match &&
      (match.players[0].clientId === clientId || match.players[1].clientId === clientId)
    ) {
      matchedRef.current = true
      onMatchedRef.current(match)
    }
  }, [peers, clientId, name, queuedAt])

  return null
}

function VersusMatchClient({
  match,
  oppClientId,
  myState,
  onOpponent,
}: {
  match: VersusMatch
  oppClientId: string
  myState: VersusPeerWireState
  onOpponent: (s: VersusPeerWireState | null) => void
}) {
  const { peers, connected, updateState } = usePresenceRoom(`ladder:1v1:${match.matchId}`)
  const updateRef = useRef(updateState)
  updateRef.current = updateState
  const onOpponentRef = useRef(onOpponent)
  onOpponentRef.current = onOpponent

  // Publish our side's state whenever it changes (steps, distance,
  // status — never the current word; the path only after resolution).
  const myKey = JSON.stringify(myState)
  useEffect(() => {
    updateRef.current({ vsMatch: JSON.parse(myKey) as VersusPeerWireState })
  }, [myKey, connected])

  // The opponent is the peer whose match state carries their client id.
  const oppWire = peers
    .map(
      (p) =>
        (p.state as Record<string, unknown> | undefined)?.vsMatch as
          | VersusPeerWireState
          | undefined,
    )
    .find((s) => s?.clientId === oppClientId)
  const oppKey = oppWire ? JSON.stringify(oppWire) : ''
  useEffect(() => {
    onOpponentRef.current(oppKey ? (JSON.parse(oppKey) as VersusPeerWireState) : null)
  }, [oppKey])

  return null
}

export default function PlayPage() {
  const [mode, setMode] = useState<Mode>('daily')
  // Word length for Practice / Bot / 1v1 (Daily is always 4-letter).
  const [wordLength, setWordLength] = useState<WordLength>(4)
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

  // --- 1v1 mode ------------------------------------------------------------
  // Queue + match run on presence rooms (see VersusQueueClient /
  // VersusMatchClient above). My side's state lives in a ref so timer
  // callbacks always see the latest values; bumping versusSideVersion
  // re-renders so the match client re-publishes it.
  const [versusClientId] = useState(
    () =>
      (typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `vs-${Math.random().toString(36).slice(2)}-${Date.now()}`) as string,
  )
  const [versusName, setVersusName] = useState(() => {
    try {
      return localStorage.getItem(NAME_KEY) ?? ''
    } catch {
      return ''
    }
  })
  const [versusStage, setVersusStage] = useState<'entry' | 'queued' | 'match' | 'done'>(
    'entry',
  )
  const [versusQueueSession, setVersusQueueSession] = useState(0)
  const [versusQueueCount, setVersusQueueCount] = useState(1)
  const [versusQueueError, setVersusQueueError] = useState<string | null>(null)
  const [versusPair, setVersusPair] = useState<{ start: string; end: string } | null>(null)
  const [versusMatch, setVersusMatch] = useState<VersusMatch | null>(null)
  const [versusOpp, setVersusOpp] = useState<VersusPeerWireState | null>(null)
  const [versusOppInMatch, setVersusOppInMatch] = useState(false)
  const [versusResult, setVersusResult] = useState<VersusResult | null>(null)
  const [versusSideVersion, setVersusSideVersion] = useState(0)
  const versusQueuedAtRef = useRef(0)
  const versusMatchRef = useRef<VersusMatch | null>(null)
  const versusOppRef = useRef<VersusPeerWireState | null>(null)
  const versusMySideRef = useRef<VersusSideState>({ status: 'playing' })
  const versusResolvedRef = useRef(false)
  const versusSettleTimerRef = useRef<number | null>(null)
  const versusDcTimerRef = useRef<number | null>(null)
  const versusJoinTimerRef = useRef<number | null>(null)
  const versusOppSeenRef = useRef(false)

  const pair =
    mode === 'daily'
      ? daily
      : mode === 'practice'
        ? practicePair
        : mode === 'bot'
          ? botPair
          : versusPair
  const start = pair?.start ?? ''
  const end = pair?.end ?? ''
  /** Word length of the current pair (4 for the daily, 4 or 5 elsewhere). */
  const wordLen = pair?.start.length === 5 ? 5 : 4

  /** Shortest distance of the current pair — the denominator for the
   * distance-left progress bars in the bot / 1v1 panels. (The number
   * itself is never displayed, so the par stays hidden.) */
  const startDist = useMemo(
    () => (pair ? bfs(pair.start, pair.end, bucketsForLength(pair.start.length)).dist : null),
    [pair],
  )

  // The position locked for the next rung: the one changed on the last step.
  const prevWord = path.length > 0 ? path[path.length - 1] : ''
  const lockedPos =
    path.length >= 2 ? diffIndex(path[path.length - 2], prevWord) : -1

  // My 1v1 broadcast: steps + distance only. The path rides along only
  // once the match is resolved (side.reveal), for the side-by-side reveal.
  const versusMyWire: VersusPeerWireState | null = useMemo(() => {
    if (!versusMatch || mode !== 'versus') return null
    const side = versusMySideRef.current
    const current = path[path.length - 1] ?? ''
    const locked = path.length >= 2 ? diffIndex(path[path.length - 2], current) : -1
    const dist = current
      ? bfs(current, versusMatch.pair.end, bucketsForLength(versusMatch.pair.end.length), 3, locked).dist
      : 0
    return {
      name: versusName,
      clientId: versusClientId,
      status: side.status,
      steps: Math.max(0, path.length - 1),
      distance: dist < 0 ? null : dist,
      finishMs: side.finishMs,
      finishSteps: side.finishSteps,
      gaveUpMs: side.gaveUpMs,
      path: side.reveal ? [...path] : undefined,
    }
  }, [versusMatch, mode, path, versusName, versusClientId, versusSideVersion])

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

  const loadPractice = useCallback(async (length: WordLength = 4) => {
    setLoadError(null)
    try {
      const res = await fetch(`/api/practice?length=${length}`)
      const data = (await res.json()) as { start: string; end: string }
      setPracticePair(data)
      setPath([data.start])
    } catch {
      setLoadError('Could not load a practice ladder. Check your connection and try again.')
    }
  }, [])

  /** Switching practice word length starts a fresh ladder at that length. */
  function changePracticeLength(len: WordLength) {
    if (len === wordLength) return
    setWordLength(len)
    setPhase('playing')
    setResult(null)
    setPendingFinish(null)
    setError(null)
    setInput('')
    setHintsUsed(0)
    setElapsed(0)
    startAtRef.current = null
    void loadPractice(len)
  }

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
      clearVersusTimers()
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
    const remaining = bfs(word, pair.end, bucketsForLength(pair.end.length), 3, locked).dist
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
    const par = pair ? bfs(pair.start, pair.end, bucketsForLength(pair.start.length)).dist : 0
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
      const res = await fetch(`/api/practice?length=${wordLength}`)
      const data = (await res.json()) as { start: string; end: string }
      const cfg = BOT_LEVELS[difficulty]
      const buckets = bucketsForLength(wordLength)
      const sets = setsForLength(wordLength)
      const optimal = preferredPath(data.start, data.end, buckets, -1, sets)
      const line =
        difficulty === 'high'
          ? optimal
          : (wanderingPath(data.start, data.end, { greediness: cfg.greediness }, buckets, sets) ??
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
      setBotDistLeft(bfs(data.start, data.end, buckets).dist)
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

  // --- 1v1 mode ------------------------------------------------------------
  function clearVersusTimers() {
    for (const ref of [versusSettleTimerRef, versusDcTimerRef, versusJoinTimerRef]) {
      if (ref.current !== null) {
        clearTimeout(ref.current)
        ref.current = null
      }
    }
  }

  function updateMySide(patch: Partial<VersusSideState>) {
    versusMySideRef.current = { ...versusMySideRef.current, ...patch }
    setVersusSideVersion((v) => v + 1)
  }

  function resetVersus() {
    clearVersusTimers()
    versusMatchRef.current = null
    versusOppRef.current = null
    versusMySideRef.current = { status: 'playing' }
    versusResolvedRef.current = false
    versusOppSeenRef.current = false
    setVersusMatch(null)
    setVersusPair(null)
    setVersusOpp(null)
    setVersusOppInMatch(false)
    setVersusResult(null)
    setVersusQueueError(null)
    setVersusQueueCount(1)
    setVersusSideVersion((v) => v + 1)
  }

  function joinVersusQueue() {
    const trimmed = versusName.trim()
    if (!trimmed) {
      setVersusQueueError('Enter a name first.')
      return
    }
    if (trimmed.length > 20) {
      setVersusQueueError('Keep it to 20 characters.')
      return
    }
    try {
      localStorage.setItem(NAME_KEY, trimmed)
    } catch {
      // Non-fatal.
    }
    setVersusName(trimmed)
    versusQueuedAtRef.current = Date.now()
    setVersusQueueSession((s) => s + 1)
    setVersusQueueError(null)
    setVersusStage('queued')
  }

  function leaveVersusQueue() {
    resetVersus()
    setVersusStage('entry')
  }

  function handleVersusMatched(match: VersusMatch) {
    if (versusMatchRef.current) return
    versusMatchRef.current = match
    setVersusMatch(match)
    setVersusPair(match.pair)
    setPath([match.pair.start])
    setPhase('playing')
    setResult(null)
    setPendingFinish(null)
    setError(null)
    setInput('')
    setElapsed(0)
    startAtRef.current = null
    setVersusStage('match')
    // If the opponent never shows up in the match room, stop waiting and
    // re-queue with a fresh timestamp (back of the line), so we cannot
    // deadlock on a player who left mid-handshake.
    versusJoinTimerRef.current = window.setTimeout(() => {
      versusJoinTimerRef.current = null
      if (!versusOppSeenRef.current && !versusResolvedRef.current) {
        resetVersus()
        versusQueuedAtRef.current = Date.now()
        setVersusQueueSession((s) => s + 1)
        setVersusStage('queued')
      }
    }, OPPONENT_JOIN_TIMEOUT_MS)
    focusInput()
  }

  function finishVersusMatch(outcome: {
    winner: 'me' | 'opponent'
    reason: 'finish' | 'forfeit' | 'disconnect'
  }) {
    if (versusResolvedRef.current) return
    versusResolvedRef.current = true
    clearVersusTimers()
    const match = versusMatchRef.current
    const mySeconds =
      startAtRef.current === null ? 0 : Math.floor((Date.now() - startAtRef.current) / 1000)
    const opp = versusOppRef.current
    // Publish the full path now that the match is resolved — the reveal.
    updateMySide({ reveal: true })
    setVersusResult({
      winner: outcome.winner === 'me' ? 'you' : 'opponent',
      reason: outcome.reason,
      mySteps: playerPathRef.current.length - 1,
      mySeconds,
      oppSteps: opp?.finishSteps ?? (opp ? opp.steps : null),
      oppSeconds:
        opp?.finishMs != null && match ? Math.floor(opp.finishMs / 1000) : null,
      oppName: match
        ? (match.players.find((p) => p.clientId !== versusClientId)?.name ?? 'Opponent')
        : 'Opponent',
      oppPath: opp?.path ?? null,
    })
    setPhase('finished')
    setVersusStage('done')
  }

  function maybeSettleVersus() {
    if (versusResolvedRef.current || !versusMatchRef.current) return
    const me = versusMySideRef.current
    const opp = versusOppRef.current
    const oppSide: VersusSideState | null = opp
      ? {
          status: opp.status,
          finishMs: opp.finishMs,
          finishSteps: opp.finishSteps,
          gaveUpMs: opp.gaveUpMs,
        }
      : null
    const outcome = resolveVersus(me, oppSide, { settleDone: false, oppGone: false })
    if (outcome.status === 'decided') {
      finishVersusMatch(outcome)
      return
    }
    // Someone finished — give the other side's finish a moment to arrive
    // before deciding, so a near-simultaneous finish still tie-breaks.
    const someoneFinished =
      me.status === 'finished' ||
      me.status === 'done' ||
      (oppSide !== null && (oppSide.status === 'finished' || oppSide.status === 'done'))
    if (someoneFinished && versusSettleTimerRef.current === null) {
      versusSettleTimerRef.current = window.setTimeout(() => {
        versusSettleTimerRef.current = null
        if (versusResolvedRef.current) return
        const m = versusMySideRef.current
        const o = versusOppRef.current
        const oSide: VersusSideState | null = o
          ? {
              status: o.status,
              finishMs: o.finishMs,
              finishSteps: o.finishSteps,
              gaveUpMs: o.gaveUpMs,
            }
          : null
        const out = resolveVersus(m, oSide, { settleDone: true, oppGone: false })
        if (out.status === 'decided') finishVersusMatch(out)
      }, SETTLE_MS)
    }
  }

  function handleVersusOpponent(opp: VersusPeerWireState | null) {
    const wasSeen = versusOppSeenRef.current
    versusOppRef.current = opp
    setVersusOpp(opp)
    if (opp) {
      versusOppSeenRef.current = true
      setVersusOppInMatch(true)
      if (versusDcTimerRef.current !== null) {
        clearTimeout(versusDcTimerRef.current)
        versusDcTimerRef.current = null
      }
      // The opponent's path may arrive after we already resolved — stash
      // it into the result so the reveal fills in (and survives them
      // leaving right after).
      if (versusResolvedRef.current && opp.path) {
        setVersusResult((prev) =>
          prev && !prev.oppPath ? { ...prev, oppPath: opp.path! } : prev,
        )
      }
      maybeSettleVersus()
    } else if (wasSeen && !versusResolvedRef.current) {
      // Opponent vanished mid-match: give them a grace period to
      // reconnect before calling it a win by disconnect.
      if (versusDcTimerRef.current === null) {
        versusDcTimerRef.current = window.setTimeout(() => {
          versusDcTimerRef.current = null
          if (versusResolvedRef.current) return
          const out = resolveVersus(versusMySideRef.current, null, {
            settleDone: true,
            oppGone: true,
          })
          if (out.status === 'decided') finishVersusMatch(out)
        }, DISCONNECT_GRACE_MS)
      }
    }
  }

  function finishVersusRound(finalPath: string[]) {
    const match = versusMatchRef.current
    if (!match || versusResolvedRef.current) return
    updateMySide({
      status: 'finished',
      finishMs: Date.now() - match.epoch,
      finishSteps: finalPath.length - 1,
    })
    setPhase('finished')
    maybeSettleVersus()
  }

  function queueVersusAgain() {
    resetVersus()
    setPhase('playing')
    setResult(null)
    setPendingFinish(null)
    setError(null)
    setInput('')
    versusQueuedAtRef.current = Date.now()
    setVersusQueueSession((s) => s + 1)
    setVersusStage('queued')
    focusInput()
  }

  function versusChangeName() {
    resetVersus()
    setPhase('playing')
    setResult(null)
    setPendingFinish(null)
    setError(null)
    setInput('')
    setPath([])
    setVersusStage('entry')
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
    // 1v1: reaching the end first wins the race — no server scoring.
    if (mode === 'versus') {
      finishVersusRound(finalPath)
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
    // 1v1: giving up forfeits the race to the opponent.
    if (mode === 'versus') {
      if (!versusMatchRef.current || versusResolvedRef.current) return
      updateMySide({
        status: 'gave-up',
        gaveUpMs: Date.now() - versusMatchRef.current.epoch,
      })
      maybeSettleVersus()
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
    if (mode === 'versus') {
      queueVersusAgain()
      return
    }
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
      void loadPractice(wordLength)
    } else if (daily) {
      setPath([daily.start])
    }
    focusInput()
  }

  function switchMode(next: Mode) {
    if (next === mode) return
    clearBotTimer()
    resetBotRound()
    if (mode === 'versus') resetVersus()
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
      void loadPractice(wordLength)
    } else if (next === 'daily' && daily) {
      restoreDaily(daily.date, daily.start)
    } else if (next === 'versus') {
      setVersusStage('entry')
      setPath([])
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
            {(Object.keys(MODE_STYLE) as Mode[]).map((m) => (
              <button
                key={m}
                role="tab"
                aria-selected={mode === m}
                onClick={() => switchMode(m)}
                className={
                  mode === m
                    ? `rounded-full px-3 py-1 font-medium transition-all hover:scale-[1.04] active:scale-95 ${MODE_STYLE[m].pillActive}`
                    : `rounded-full px-3 py-1 text-muted-foreground transition-all hover:scale-[1.04] active:scale-95 ${MODE_STYLE[m].pillHover}`
                }
              >
                {MODE_STYLE[m].label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <p className={`-mt-3 mb-6 text-sm font-medium ${MODE_STYLE[mode].accentText}`}>
        {MODE_STYLE[mode].flavor}
      </p>

      {mode === 'practice' && (
        <div className="-mt-3 mb-6">
          <LengthPicker value={wordLength} onChange={changePracticeLength} accent={MODE_STYLE.practice.bar} />
        </div>
      )}

      {solvingNow !== null && (
        <p className="mb-4 text-sm text-muted-foreground">
          <span className="mr-1.5 inline-block h-2 w-2 rounded-full bg-emerald-500 align-middle" />
          {solvingNow} {solvingNow === 1 ? 'person' : 'people'} solving now
        </p>
      )}

      {loadError && (
        <div className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-foreground">
          {loadError}
          <Button variant="outline" size="sm" className="ml-3" onClick={() => (mode === 'daily' ? void loadDaily() : mode === 'practice' ? void loadPractice(wordLength) : botDifficultyRef.current ? void startBotRound(botDifficultyRef.current) : showBotPicker())}>
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
          <div className="mt-3">
            <LengthPicker value={wordLength} onChange={setWordLength} accent={MODE_STYLE.bot.bar} />
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            {(['elementary', 'middle', 'high'] as const).map((level) => (
              <button
                key={level}
                type="button"
                onClick={() => void startBotRound(level)}
                className={`rounded-lg border p-4 text-left transition-all hover:-translate-y-0.5 hover:border-violet-400 active:scale-[0.98] ${
                  botDifficulty === level ? 'border-violet-500 bg-violet-500/10 shadow-[0_4px_20px_rgba(139,92,246,0.25)]' : 'border-border bg-background'
                }`}
              >
                <span className="block text-base font-semibold text-foreground">
                  {BOT_LEVELS[level].label}
                </span>
                <span className="mt-1 block text-sm text-muted-foreground">
                  {BOT_LEVELS[level].blurb}
                </span>
                <span className="mt-3 block text-sm font-medium text-violet-400">Race →</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {mode === 'bot' && botLoading && (
        <p className="text-muted-foreground">Loading your race…</p>
      )}

      {!pair && !loadError && mode !== 'bot' && mode !== 'versus' && (
        <p className="text-muted-foreground">Loading today’s ladder…</p>
      )}

      {/* 1v1: name entry + queue */}
      {mode === 'versus' && versusStage === 'entry' && (
        <div className="rounded-lg border border-border bg-card p-5">
          <h2 className="text-lg font-semibold text-foreground">Race a live opponent</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Enter a name, join the queue, and race the first person who shows up.
          </p>
          <div className="mt-3">
            <LengthPicker value={wordLength} onChange={setWordLength} accent={MODE_STYLE.versus.bar} />
          </div>
          <div className="mt-3 flex gap-2">
            <Input
              value={versusName}
              onChange={(e) => setVersusName(e.target.value.slice(0, 20))}
              placeholder="Your name"
              aria-label="Your name for 1v1"
              maxLength={20}
              className="h-10 flex-1"
            />
            <Button onClick={joinVersusQueue} className="transition-transform hover:scale-[1.02] active:scale-95">Join queue</Button>
          </div>
          {versusQueueError && (
            <p className="mt-2 text-sm font-medium text-destructive">{versusQueueError}</p>
          )}
        </div>
      )}

      {mode === 'versus' && versusStage === 'queued' && (
        <div className="rounded-lg border border-border bg-card p-5">
          <h2 className="text-lg font-semibold text-foreground">
            In the queue as {versusName}
          </h2>
          {/* Searching visual — magnifier sweeping the ring, CSS only.
              Shows only while waiting; the whole card unmounts on match. */}
          <div className="mt-4 flex flex-col items-center gap-3" aria-hidden>
            <div className="relative flex h-16 w-16 items-center justify-center">
              <span className="absolute inset-0 rounded-full border border-amber-500/30" />
              <span className="absolute inset-0 animate-ping rounded-full border border-amber-500/40 [animation-duration:2s]" />
              <span className="animate-search-orbit absolute inset-0">
                <Search className="absolute left-1/2 top-0 h-5 w-5 -translate-x-1/2 -translate-y-1/2 text-amber-400" />
              </span>
              <span className="h-2.5 w-2.5 rounded-full bg-amber-500" />
            </div>
            <p className="text-sm font-medium text-amber-500">Finding opponent…</p>
          </div>
          <p className="mt-3 text-sm text-muted-foreground">
            Waiting for an opponent…{' '}
            {versusQueueCount > 1
              ? `${versusQueueCount} in the queue right now.`
              : 'You’re first in line.'}
          </p>
          <div className="mt-4">
            <Button variant="outline" onClick={leaveVersusQueue}>
              Leave queue
            </Button>
          </div>
        </div>
      )}

      {/* 1v1 presence: queue + match rooms (these render nothing). */}
      {mode === 'versus' &&
        (versusStage === 'queued' ||
          (versusStage === 'match' && !versusOppInMatch)) && (
          <VersusQueueClient
            key={versusQueueSession}
            clientId={versusClientId}
            name={versusName}
            queuedAt={versusQueuedAtRef.current}
            length={wordLength}
            onMatched={handleVersusMatched}
            onCount={setVersusQueueCount}
          />
        )}
      {mode === 'versus' &&
        versusMatch &&
        (versusStage === 'match' || versusStage === 'done') &&
        versusMyWire && (
          <VersusMatchClient
            match={versusMatch}
            oppClientId={
              versusMatch.players.find((p) => p.clientId !== versusClientId)?.clientId ?? ''
            }
            myState={versusMyWire}
            onOpponent={handleVersusOpponent}
          />
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
                            className={`relative flex h-11 w-11 items-center justify-center rounded-lg border-2 text-lg font-bold uppercase shadow-sm ${
                              j === changed
                                ? MODE_STYLE[mode].changedTile
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
                      className="flex h-11 w-11 items-center justify-center rounded-lg border-2 border-dashed border-border text-lg font-bold uppercase text-muted-foreground"
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
                    onChange={(e) => setInput(e.target.value.replace(/[^a-zA-Z]/g, '').slice(0, wordLen))}
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
                  <Button
                    onClick={() => void submitWord()}
                    className="h-11 transition-transform hover:scale-[1.03] active:scale-95"
                  >
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
                    <Button onClick={playAgain} className="transition-transform hover:scale-[1.02] active:scale-95">Another practice ladder</Button>
                  </div>
                )}
                {result.gaveUp && (
                  <div className="mt-4">
                    <Button onClick={playAgain} className="transition-transform hover:scale-[1.02] active:scale-95">Try again</Button>
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
                    <RevealList words={botResult.botPath} />
                  </div>
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button onClick={playAgain} className="transition-transform hover:scale-[1.02] active:scale-95">Race again</Button>
                  <Button variant="outline" onClick={showBotPicker}>
                    Change difficulty
                  </Button>
                </div>
              </div>
            )}

            {phase === 'finished' && mode === 'versus' && !versusResult && (
              <div className="mt-6 rounded-lg border border-border bg-card p-5">
                <h2 className="text-lg font-semibold text-foreground">Finished!</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Checking the result…
                </p>
              </div>
            )}

            {phase === 'finished' && mode === 'versus' && versusResult && (
              <div className="mt-6 rounded-lg border border-border bg-card p-5">
                <h2 className="text-lg font-semibold text-foreground">
                  {versusResult.winner === 'you'
                    ? 'You won the race! 🎉'
                    : versusResult.reason === 'forfeit'
                      ? 'You gave up — your opponent wins'
                      : versusResult.reason === 'disconnect'
                        ? 'Your opponent left — you win'
                        : `${versusResult.oppName} beat you`}
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  You: {versusResult.mySteps} steps · {formatTime(versusResult.mySeconds)}
                  {' · '}
                  {versusResult.oppName}:{' '}
                  {versusResult.oppSteps === null
                    ? '—'
                    : `${versusResult.oppSteps} steps${
                        versusResult.oppSeconds !== null
                          ? ` · ${formatTime(versusResult.oppSeconds)}`
                          : ''
                      }`}
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
                      Opponent’s path
                    </h3>
                    {versusResult.oppPath ? (
                      <RevealList words={versusResult.oppPath} />
                    ) : versusOpp?.path ? (
                      <RevealList words={versusOpp.path} />
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        {versusResult.reason === 'disconnect'
                          ? 'Your opponent left before the reveal.'
                          : 'Waiting for your opponent’s path…'}
                      </p>
                    )}
                  </div>
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button onClick={playAgain} className="transition-transform hover:scale-[1.02] active:scale-95">Queue again</Button>
                  <Button variant="outline" onClick={versusChangeName}>
                    Change name
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
                  <Button
                    onClick={() => void saveWithName()}
                    disabled={saving || !name.trim()}
                    className="transition-transform hover:scale-[1.02] active:scale-95"
                  >
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
                {/* Steps + distance only — the bot's current word stays
                    hidden while racing, or the player could copy its moves. */}
                <dl className="space-y-1.5 text-sm">
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Bot steps</dt>
                    <dd className="text-base font-extrabold text-foreground">{botIndex}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Distance left</dt>
                    <dd className="text-base font-extrabold text-foreground">
                      {botDistLeft === null ? '—' : `${botDistLeft} to go`}
                    </dd>
                  </div>
                </dl>
                <div className="mt-2">
                  <MiniBar
                    fraction={
                      startDist === null || botDistLeft === null
                        ? 0
                        : 1 - botDistLeft / startDist
                    }
                    className={MODE_STYLE.bot.bar}
                  />
                </div>
                {phase === 'playing' && (
                  <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-emerald-500" />
                    Bot is thinking…
                  </p>
                )}
              </div>
            ) : mode === 'versus' ? (
              <div className="rounded-lg border border-border bg-card p-4">
                <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Opponent · {versusOpp ? versusOpp.name : 'waiting…'}
                </h2>
                {versusStage === 'match' || versusStage === 'done' ? (
                  versusOpp ? (
                    <>
                      <dl className="space-y-1.5 text-sm">
                        <div className="flex justify-between">
                          <dt className="text-muted-foreground">Steps</dt>
                          <dd className="text-base font-extrabold text-foreground">{versusOpp.steps}</dd>
                        </div>
                        <div className="flex justify-between">
                          <dt className="text-muted-foreground">Distance left</dt>
                          <dd className="text-base font-extrabold text-foreground">
                            {versusOpp.distance === null
                              ? '—'
                              : `${versusOpp.distance} to go`}
                          </dd>
                        </div>
                      </dl>
                      <div className="mt-2">
                        <MiniBar
                          fraction={
                            startDist === null || versusOpp.distance === null
                              ? 0
                              : 1 - versusOpp.distance / startDist
                          }
                          className={MODE_STYLE.versus.bar}
                        />
                      </div>
                      {phase === 'playing' && (
                        <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
                          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-emerald-500" />
                          Opponent is playing…
                        </p>
                      )}
                    </>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      Waiting for your opponent to join…
                    </p>
                  )
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Join the queue to race a live opponent.
                  </p>
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
                      <div className="mt-1.5">
                        <MiniBar fraction={parRate / 100} className="bg-emerald-500" />
                      </div>
                    </div>
                  </dl>
                  {mode === 'daily' && solvedToday ? (
                    <p className="mt-4 text-xs text-muted-foreground">
                      Saved as{' '}
                      <span className="font-semibold text-foreground">{solvedToday.name}</span>
                      {' '}— your name is locked in for today.
                    </p>
                  ) : mode === 'daily' ? (
                    // Practice has no name field: practice scores never reach
                    // the leaderboard, so there is nothing to name.
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
                  ) : null}
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
