# Ladder

A daily word-ladder game: one shared puzzle a day, server-enforced rules.
Live at https://ladder.app.space

Turn the start word into the end word, changing one letter at a time. Every step must be a real word, and the letter you just changed is locked for the next rung.

Modes: Daily (one shared puzzle, solved locks the day), Practice, Bot race (Elementary / Middle / High), and live 1v1. Practice, Bot, and 1v1 offer 4- and 5-letter ladders; daily stays 4-letter.

Built with React + Hono on DeepSpace (Cloudflare Workers), Durable Objects for scores, presence, and matches, and a cron-seeded leaderboard.

## Run it locally

```bash
npm install
npx deepspace dev start
```

Tests: `npx vitest run` · Typecheck: `npx tsc --noEmit`
