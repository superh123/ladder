/**
 * Landing page — a STATIC page.
 *
 * It lives at the top level of src/pages/ (not under (app)/), so it renders
 * with no DeepSpace providers: no auth session fetch, no records WebSocket.
 * That makes it cheap to serve and safe for logged-out / crawler traffic.
 *
 * Top-level pages are also prerendered to static HTML at build
 * (prerender.ts, via vite.config.ts) so crawlers read real content.
 * Keep them renderable without a browser: no window/document during render,
 * prose in HTML text, reveal animations in CSS keyframes rather than JS-driven
 * initial states. `<Seo>` comes first and reads src/seo.ts.
 */

import { Link } from 'react-router-dom'
import { Seo } from '../components/Seo'
import { seo } from '../seo'

const EXAMPLE = ['COLD', 'WOLD', 'WORD', 'WARD', 'WARM']

const RULES = [
  {
    title: '1. One letter at a time',
    body: 'Change exactly one letter per step. Every step must be a real word — COLD → CORD is fine, COLD → COLT is too, but COLD → COLD is not a move.',
  },
  {
    title: '2. Beat the par',
    body: 'Every daily ladder has a true shortest path, computed by breadth-first search over the word graph. The par stays hidden until you finish — or give up.',
  },
  {
    title: '3. One ladder a day',
    body: 'Everyone gets the same puzzle each UTC day. Unlimited retries, best result counts. Streaks live on your device — no sign-in, ever.',
  },
]

export default function Landing() {
  return (
    <>
      <Seo {...seo} path="/" />
      <div
        data-testid="static-landing"
        className="flex min-h-screen flex-col items-center px-6 py-16 text-center"
      >
        <p className="mb-3 text-sm uppercase tracking-widest text-muted-foreground">
          Ladder
        </p>
        <h1 className="mb-4 max-w-2xl text-4xl font-bold tracking-tight text-foreground sm:text-5xl">
          One ladder a day. Beat the par.
        </h1>
        <p className="mb-6 max-w-md text-muted-foreground">
          Turn the start word into the end word, changing one letter at a time.
          A new shared puzzle every day — no sign-in, just the shortest path
          standing between you and par.
        </p>
        <div className="mb-8 flex items-center gap-1.5" aria-label="Example ladder: cold to warm in three steps">
          {EXAMPLE.map((word, i) => (
            <span key={word} className="flex items-center gap-1.5">
              {i > 0 && <span className="text-muted-foreground">→</span>}
              <span className="rounded-md border border-border bg-card px-2.5 py-1.5 font-mono text-sm font-bold tracking-widest text-foreground">
                {word}
              </span>
            </span>
          ))}
          <span className="ml-2 text-sm font-medium text-emerald-600">par 4</span>
        </div>
        <Link
          to="/play"
          className="mb-12 inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
        >
          Play today’s ladder
        </Link>
        <div className="grid w-full max-w-3xl gap-4 text-left sm:grid-cols-3">
          {RULES.map((rule) => (
            <div
              key={rule.title}
              className="rounded-lg border border-border bg-card p-4"
            >
              <h2 className="mb-1 text-sm font-semibold text-foreground">{rule.title}</h2>
              <p className="text-sm text-muted-foreground">{rule.body}</p>
            </div>
          ))}
        </div>
        <p className="mt-10 max-w-md text-sm text-muted-foreground">
          Finished the daily? Practice mode deals unlimited random ladders —
          same rules, no leaderboard.
        </p>
      </div>
    </>
  )
}
