# Ladder

A daily word-ladder game: one shared puzzle a day, server-enforced rules.
Live at **https://ladder.app.space** — built on DeepSpace (React + Hono on
Cloudflare Workers).

Turn the start word into the end word, changing one letter at a time. Every
step must be a real word, and the letter you just changed is **locked for the
next rung** — so the optimal path is never the only path.

## What you built

- **Daily** — one shared puzzle a day, deterministic UTC pair (par 4–6, at
  least two distinct shortest paths, 90-pair bank). Solve it once and the day
  is done: a Wordle-style Solved state, one leaderboard entry per player per
  day, name locked after the first submit. No sign-in; play is free.
- **Practice** — endless ladders, hints, give-up with an optimal-path reveal.
- **Bot race** — race a bot from the same start word, three difficulties
  (Elementary / Middle / High). During a race you see only the bot's steps
  and distance left, never its word; its path is revealed at the end, cut off
  where it actually stopped.
- **Live 1v1** — enter a name, join a queue, race the first person who shows
  up. Same ladder, first to the target wins; finishes within 2s tie-break by
  fewer steps, then faster time. Give-up forfeits; an opponent who disconnects
  is a win after a 5s grace.
- **4- and 5-letter submodes** in Practice, Bot, and 1v1 (daily stays
  4-letter). The 5-letter bank is 60 pairs, par 4–7, same quality bar.

The engine is exact computation: wildcard-bucket adjacency plus BFS shortest
path with distinct-shortest-path counting (`src/lib/ladder.ts`). The server
re-validates every step and every submission; the par and the optimal path are
never sent before a valid finish. Hints disqualify a par hit.

## Which primitives were used

- **Durable Objects** — scores (one per date, admin-only collection, writes
  through the owner server context so anonymous play works), presence rooms
  (who is solving today, the 1v1 queue, the 1v1 match room), and match state.
- **Cron** — a `seed-board` job at 00:05 UTC seeds 12 deterministic leaderboard
  rows per day, with lazy seeding on leaderboard read as a fallback.
- **Presence** — the 1v1 queue and match run entirely on presence rooms: the
  two longest-waiting queuers derive the same match id and the same pair
  deterministically from shared queue state. Opponent progress is steps +
  distance only, never the opponent's word; paths are published only after
  the match resolves.
- **GitHub source** — the repository is the deploy source; releases ship the
  current checkout of `master`.

No platform primitive was reimplemented: matching, presence, and persistence
all ride on the ones above instead of a hand-rolled websocket server or an
external database.

## Integrations — what was useful, and why not more

The app is self-contained by design, so it needs almost no third-party
services. The useful integrations are the platform's own: Durable Objects,
cron, and presence (above), plus GitHub as the source of truth.

Deliberately **not** added:

- **No AI.** The answer to a ladder is exact computation — BFS over a fixed
  dictionary. A model would only blur it, so there is no AI integration
  anywhere in the app.
- **No email digest.** A daily game with a Solved state and a seeded
  leaderboard does not get better from a digest; it would be noise.
- **No auth / sign-in.** Play is free and the leaderboard is per-browser
  (localStorage name lock). Sign-in would add friction and a whole auth
  surface for no gameplay benefit.
- **No external word API.** The word lists are bundled data, built from
  public word lists (google-10000-english, dwyl `words_alpha`, Hunspell
  en_US) with a blocklist, and the pair banks are precomputed with
  revalidation scripts (`scripts/precompute-pairs*.mjs`,
  `scripts/revalidate-pairs.mjs`). Nothing at runtime depends on an outside
  service, so the game works even if every external API is down.

## The main tradeoff

Bot mode ships the solver in the client bundle (the bot needs the word lists
and BFS to race locally), so a determined user could compute the daily par
from devtools. Daily scoring is still fully server-validated — knowing the
par does not let you fake a submission, since the server re-validates the
whole path and the lock rule. The alternative was a server-side bot, which
would add latency and a whole extra service for a casual race. I kept the
client-side bot and the server-side scoring.

## What the agent did, and what I verified or changed

The agent (Milo) built the scaffolding, the engine, the word lists and pair
banks, the four modes, and the deploys, and verified each round at the API
and bundle level (tsc, 61 vitest tests, build, dev-server smoke tests, live
checks after every deploy).

I made the product decisions: the idea (after rejecting an issue-scorer as
too generic — anything an LLM could do from a pasted link was out), the lock
rule, solved-locks-the-day, practice-only hints, the bot anti-cheat, 1v1,
5-letter submodes, and the visual direction. I verified the app in a real
browser: played the daily through at par, checked the Solved state and name
lock, and watched real players land on the leaderboard.

## Honest unfinished edges

- **A real 1v1 match has not been played by two humans yet.** The queue,
  match derivation, progress broadcast, finish resolution, and disconnect
  detection were verified at the protocol level with two simulated clients
  (6/6 checks), but a live two-browser match is still untested.
- **The 5-letter pair bank has a few name-like endpoints** (`larry`,
  `james`, `hayes`, `singh`, `leeds`, `elvis`, `evans`) — the same bar as
  the 4-letter bank, which has `hong`, `alan`, `anne`.
- **The name lock is per-browser** (localStorage), not per-person; clearing
  storage or using another browser bypasses it.
- **Give-up reveals the optimal path**, which can then be submitted for par
  (same shape as Wordle answer leaks). Hints disqualify a par hit; give-up
  does not.

## Secrets and code

There are no secrets: no API keys, no external accounts, no credentials of
any kind in the app or the repo. The code is split so each piece is readable
on its own — engine (`src/lib/ladder.ts`), word lists
(`src/lib/words-*.ts`), pair banks (`src/lib/daily-pairs.ts`,
`src/lib/practice-pairs-5.ts`), server routes
(`src/server/ladder-routes.ts`), 1v1 logic (`src/lib/versus.ts`), and the
game page (`src/pages/(app)/play.tsx`).

## Run it locally

```bash
npm install
npx deepspace dev start
```

Tests: `npx vitest run` (61 tests) · Typecheck: `npx tsc --noEmit`
