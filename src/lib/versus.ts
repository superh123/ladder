/**
 * 1v1 matchmaking + match resolution — pure functions, no React, no network.
 *
 * The match itself runs on the starter's presence rooms (see play.tsx):
 * players meet in `ladder:1v1-queue`, then race in `ladder:1v1:<matchId>`.
 * Everything both clients must agree on — who is matched, which pair,
 * who won — is derived here from data both sides can see, so the two
 * browsers converge on the same answer without a server.
 *
 * ANTI-CHEAT SHAPE: during a match each side only ever broadcasts steps
 * taken and distance left — never its current word, and never its path.
 * The full path is published only after the match is resolved, for the
 * side-by-side reveal.
 *
 * CLOCKS: finish times are ms since the match epoch (the earlier of the
 * two queuedAt timestamps, which both clients see). Two browsers' clocks
 * can still disagree by a second or two, which is why finishes within
 * SIMULTANEOUS_MS count as "the same time" and fall through to the
 * shorter-path / faster-time tie-break.
 */

import { DAILY_PAIRS } from './daily-pairs'

export interface QueueCandidate {
  clientId: string
  name: string
  queuedAt: number
}

export interface VersusMatch {
  matchId: string
  players: [QueueCandidate, QueueCandidate]
  pair: { start: string; end: string }
  /** Shared epoch (ms) — finish times are measured as ms since this. */
  epoch: number
}

export type VersusSideStatus = 'playing' | 'finished' | 'gave-up' | 'done'

export interface VersusSideState {
  status: VersusSideStatus
  /** ms since the match epoch, set when the side finishes. */
  finishMs?: number
  /** Steps taken when the side finished. */
  finishSteps?: number
  /** ms since the match epoch, set when the side gives up. */
  gaveUpMs?: number
  /** Set at resolution: the full path may now be published for the reveal. */
  reveal?: boolean
}

export type VersusOutcome =
  | { status: 'pending' }
  | {
      status: 'decided'
      winner: 'me' | 'opponent'
      reason: 'finish' | 'forfeit' | 'disconnect'
    }

/** Finishes this close together count as "the exact same time". */
export const SIMULTANEOUS_MS = 2000
/** After a finish is seen, wait this long for the other side's finish to arrive. */
export const SETTLE_MS = 2500
/** Opponent never shows up in the match room: re-queue after this long. */
export const OPPONENT_JOIN_TIMEOUT_MS = 15000
/** Opponent vanished from the match room: win by default after this long. */
export const DISCONNECT_GRACE_MS = 5000

function hashString(s: string): number {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h
}

/** The pair for a match, derived from the match id — both sides agree. */
export function pairForMatch(matchId: string): { start: string; end: string } {
  const [start, end] = DAILY_PAIRS[hashString(matchId) % DAILY_PAIRS.length]
  return { start, end }
}

/**
 * Match the two longest-waiting queuers. Deterministic: every client that
 * sees the same candidate set computes the same match. Returns null with
 * fewer than two candidates.
 */
export function deriveMatch(candidates: QueueCandidate[]): VersusMatch | null {
  if (candidates.length < 2) return null
  const sorted = [...candidates].sort(
    (a, b) => a.queuedAt - b.queuedAt || (a.clientId < b.clientId ? -1 : 1),
  )
  const [a, b] = sorted
  const matchId = `vs-${a.clientId.slice(0, 8)}-${b.clientId.slice(0, 8)}-${a.queuedAt}`
  return {
    matchId,
    players: [a, b],
    pair: pairForMatch(matchId),
    epoch: Math.min(a.queuedAt, b.queuedAt),
  }
}

function isFinished(s: VersusSideState): boolean {
  return s.status === 'finished' || s.status === 'done'
}

/**
 * Resolve a match from both sides' states. `settleDone` is true once the
 * settle window after the first finish has elapsed; before that, a lone
 * finish stays pending so the other side's finish can still arrive.
 * `oppGone` is true once the opponent has been absent from the match room
 * past the disconnect grace period.
 */
export function resolveVersus(
  me: VersusSideState | null,
  opp: VersusSideState | null,
  opts: { settleDone: boolean; oppGone: boolean },
): VersusOutcome {
  if (!me) return { status: 'pending' }
  const meGaveUp = me.status === 'gave-up'
  const oppGaveUp = opp?.status === 'gave-up'
  if (meGaveUp || oppGaveUp) {
    if (meGaveUp && oppGaveUp) {
      // Earlier give-up loses; an exact tie is arbitrary but deterministic.
      return (me.gaveUpMs ?? 0) < (opp?.gaveUpMs ?? 0)
        ? { status: 'decided', winner: 'opponent', reason: 'forfeit' }
        : { status: 'decided', winner: 'me', reason: 'forfeit' }
    }
    if (meGaveUp) return { status: 'decided', winner: 'opponent', reason: 'forfeit' }
    return { status: 'decided', winner: 'me', reason: 'forfeit' }
  }
  if (!opp) {
    return opts.oppGone
      ? { status: 'decided', winner: 'me', reason: 'disconnect' }
      : { status: 'pending' }
  }
  const meDone = isFinished(me)
  const oppDone = isFinished(opp)
  if (!meDone && !oppDone) return { status: 'pending' }
  if (!opts.settleDone) return { status: 'pending' }
  if (meDone && oppDone) {
    const meAt = me.finishMs ?? Number.POSITIVE_INFINITY
    const oppAt = opp.finishMs ?? Number.POSITIVE_INFINITY
    if (Math.abs(meAt - oppAt) <= SIMULTANEOUS_MS) {
      const meSteps = me.finishSteps ?? Number.POSITIVE_INFINITY
      const oppSteps = opp.finishSteps ?? Number.POSITIVE_INFINITY
      if (meSteps !== oppSteps) {
        return meSteps < oppSteps
          ? { status: 'decided', winner: 'me', reason: 'finish' }
          : { status: 'decided', winner: 'opponent', reason: 'finish' }
      }
      return meAt <= oppAt
        ? { status: 'decided', winner: 'me', reason: 'finish' }
        : { status: 'decided', winner: 'opponent', reason: 'finish' }
    }
    return meAt < oppAt
      ? { status: 'decided', winner: 'me', reason: 'finish' }
      : { status: 'decided', winner: 'opponent', reason: 'finish' }
  }
  return meDone
    ? { status: 'decided', winner: 'me', reason: 'finish' }
    : { status: 'decided', winner: 'opponent', reason: 'finish' }
}
