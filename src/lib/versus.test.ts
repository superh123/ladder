import { describe, expect, it } from 'vitest'
import {
  deriveMatch,
  pairForMatch,
  resolveVersus,
  type QueueCandidate,
  type VersusSideState,
} from './versus'
import { DAILY_PAIRS } from './daily-pairs'
import { PRACTICE_PAIRS_5 } from './practice-pairs-5'

function candidate(
  clientId: string,
  queuedAt: number,
  name = 'Player',
  length: 4 | 5 = 4,
): QueueCandidate {
  return { clientId, name, queuedAt, length }
}

const playing: VersusSideState = { status: 'playing' }
function finished(finishMs: number, finishSteps: number): VersusSideState {
  return { status: 'finished', finishMs, finishSteps }
}
function gaveUp(gaveUpMs: number): VersusSideState {
  return { status: 'gave-up', gaveUpMs }
}

describe('pairForMatch', () => {
  it('is deterministic and always a bank pair', () => {
    const a = pairForMatch('vs-abc-def-123')
    const b = pairForMatch('vs-abc-def-123')
    expect(a).toEqual(b)
    expect(DAILY_PAIRS).toContainEqual([a.start, a.end])
    expect(pairForMatch('vs-other-id-999')).not.toEqual(a)
  })

  it('serves 5-letter pairs from the 5-letter bank', () => {
    const a = pairForMatch('vs-abc-def-123', 5)
    const b = pairForMatch('vs-abc-def-123', 5)
    expect(a).toEqual(b)
    expect(a.start).toHaveLength(5)
    expect(a.end).toHaveLength(5)
    expect(PRACTICE_PAIRS_5).toContainEqual([a.start, a.end])
  })
})

describe('deriveMatch', () => {
  it('needs at least two queuers', () => {
    expect(deriveMatch([])).toBeNull()
    expect(deriveMatch([candidate('a', 100)])).toBeNull()
  })

  it('matches the two longest-waiting queuers', () => {
    const m = deriveMatch([
      candidate('c', 300),
      candidate('a', 100),
      candidate('b', 200),
    ])
    expect(m).not.toBeNull()
    expect(m!.players.map((p) => p.clientId)).toEqual(['a', 'b'])
    expect(m!.length).toBe(4)
  })

  it('never matches across word lengths', () => {
    expect(
      deriveMatch([candidate('a', 100, 'A', 4), candidate('b', 200, 'B', 5)]),
    ).toBeNull()
  })

  it('matches the two 5-letter queuers even with a lone 4-letter waiter ahead', () => {
    const m = deriveMatch([
      candidate('a', 100, 'A', 4),
      candidate('b', 200, 'B', 5),
      candidate('c', 300, 'C', 5),
    ])
    expect(m).not.toBeNull()
    expect(m!.length).toBe(5)
    expect(m!.players.map((p) => p.clientId)).toEqual(['b', 'c'])
    expect(m!.pair.start).toHaveLength(5)
  })

  it('breaks queuedAt ties by clientId and is deterministic', () => {
    const list = [candidate('b', 100), candidate('a', 100)]
    const m1 = deriveMatch(list)
    const m2 = deriveMatch([...list].reverse())
    expect(m1).toEqual(m2)
    expect(m1!.players.map((p) => p.clientId)).toEqual(['a', 'b'])
    expect(m1!.pair).toEqual(pairForMatch(m1!.matchId))
    expect(m1!.epoch).toBe(100)
  })
})

describe('resolveVersus', () => {
  it('is pending while both are playing', () => {
    expect(
      resolveVersus(playing, playing, { settleDone: true, oppGone: false }),
    ).toEqual({ status: 'pending' })
  })

  it('waits out the settle window on a lone finish, then the finisher wins', () => {
    const me = finished(5000, 4)
    expect(
      resolveVersus(me, playing, { settleDone: false, oppGone: false }),
    ).toEqual({ status: 'pending' })
    expect(
      resolveVersus(me, playing, { settleDone: true, oppGone: false }),
    ).toEqual({ status: 'decided', winner: 'me', reason: 'finish' })
    expect(
      resolveVersus(playing, finished(6000, 5), { settleDone: true, oppGone: false }),
    ).toEqual({ status: 'decided', winner: 'opponent', reason: 'finish' })
  })

  it('earliest finish wins when finishes are far apart', () => {
    expect(
      resolveVersus(finished(5000, 6), finished(9000, 4), {
        settleDone: true,
        oppGone: false,
      }),
    ).toEqual({ status: 'decided', winner: 'me', reason: 'finish' })
    expect(
      resolveVersus(finished(9000, 4), finished(5000, 6), {
        settleDone: true,
        oppGone: false,
      }),
    ).toEqual({ status: 'decided', winner: 'opponent', reason: 'finish' })
  })

  it('simultaneous finishes go to the shorter path, then faster time', () => {
    // 1s apart — inside the simultaneity window — but I took more steps.
    expect(
      resolveVersus(finished(5000, 6), finished(6000, 4), {
        settleDone: true,
        oppGone: false,
      }),
    ).toEqual({ status: 'decided', winner: 'opponent', reason: 'finish' })
    // Same steps: the earlier finish wins.
    expect(
      resolveVersus(finished(6000, 4), finished(5000, 4), {
        settleDone: true,
        oppGone: false,
      }),
    ).toEqual({ status: 'decided', winner: 'opponent', reason: 'finish' })
  })

  it('a give-up forfeits immediately, no settle needed', () => {
    expect(
      resolveVersus(gaveUp(1000), playing, { settleDone: false, oppGone: false }),
    ).toEqual({ status: 'decided', winner: 'opponent', reason: 'forfeit' })
    expect(
      resolveVersus(playing, gaveUp(1000), { settleDone: false, oppGone: false }),
    ).toEqual({ status: 'decided', winner: 'me', reason: 'forfeit' })
    // Both gave up: the earlier one loses.
    expect(
      resolveVersus(gaveUp(1000), gaveUp(2000), { settleDone: false, oppGone: false }),
    ).toEqual({ status: 'decided', winner: 'opponent', reason: 'forfeit' })
  })

  it('a vanished opponent is a win only after the disconnect grace', () => {
    expect(resolveVersus(playing, null, { settleDone: true, oppGone: false })).toEqual({
      status: 'pending',
    })
    expect(resolveVersus(playing, null, { settleDone: true, oppGone: true })).toEqual({
      status: 'decided',
      winner: 'me',
      reason: 'disconnect',
    })
  })
})
