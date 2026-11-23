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

/** The letter position that changes on each step of the example ladder:
 * COLD → WOLD changes index 0, WOLD → WORD index 1, and so on. */
const CHANGED_AT = [0, 1, 2, 3]

/** Faint background letters drifting behind the hero — pure decoration. */
const DRIFT_LETTERS = [
  { ch: 'L', top: '12%', left: '8%', size: 'text-7xl', delay: '0s', duration: '8s' },
  { ch: 'A', top: '22%', left: '86%', size: 'text-6xl', delay: '1.2s', duration: '7s' },
  { ch: 'D', top: '68%', left: '5%', size: 'text-6xl', delay: '0.6s', duration: '9s' },
  { ch: 'R', top: '74%', left: '88%', size: 'text-7xl', delay: '2s', duration: '8s' },
  { ch: 'E', top: '48%', left: '94%', size: 'text-5xl', delay: '1.6s', duration: '7.5s' },
  { ch: 'W', top: '8%', left: '68%', size: 'text-5xl', delay: '0.3s', duration: '9.5s' },
]

export default function Landing() {
  return (
    <>
      <Seo {...seo} path="/" />
      <div
        data-testid="static-landing"
        className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden px-6 py-16 text-center"
      >
        {/* Glow + drifting letters behind the hero */}
        <div aria-hidden className="pointer-events-none absolute inset-0">
          <div className="animate-glow absolute left-1/2 top-1/3 h-72 w-72 -translate-x-1/2 -translate-y-1/2 rounded-full bg-emerald-500/15 blur-3xl" />
          <div className="animate-glow absolute left-1/4 top-2/3 h-56 w-56 rounded-full bg-indigo-500/15 blur-3xl [animation-delay:1.5s]" />
          {DRIFT_LETTERS.map((l) => (
            <span
              key={`${l.ch}-${l.left}`}
              className={`animate-drift absolute hidden font-mono font-bold text-white/[0.05] sm:block ${l.size}`}
              style={{ top: l.top, left: l.left, animationDelay: l.delay, animationDuration: l.duration }}
            >
              {l.ch}
            </span>
          ))}
        </div>

        <div className="relative">
          <p
            className="animate-tile-in mb-3 text-sm uppercase tracking-widest text-emerald-400/90"
            style={{ animationDelay: '0ms' }}
          >
            Ladder
          </p>
          <h1
            className="animate-tile-in mb-4 max-w-2xl text-4xl font-bold tracking-tight text-foreground sm:text-6xl"
            style={{ animationDelay: '90ms' }}
          >
            One ladder a day.{' '}
            <span className="bg-gradient-to-r from-emerald-400 via-teal-300 to-indigo-400 bg-clip-text text-transparent">
              Beat the par.
            </span>
          </h1>
          <p
            className="animate-tile-in mx-auto mb-8 max-w-md text-muted-foreground"
            style={{ animationDelay: '180ms' }}
          >
            Turn the start word into the end word, changing one letter at a time.
            A new shared puzzle every day — no sign-in, just the shortest path
            standing between you and par.
          </p>

          {/* Example ladder, letter by letter: each step's changed letter
              pops in emerald as the ladder cascades left to right. */}
          <div
            className="animate-tile-in mb-10 flex flex-wrap items-center justify-center gap-1.5"
            style={{ animationDelay: '280ms' }}
            aria-label="Example ladder: cold to warm in four steps"
          >
            {EXAMPLE.map((word, i) => (
              <span key={word} className="flex items-center gap-1.5">
                {i > 0 && (
                  <span className="animate-tile-in text-muted-foreground" style={{ animationDelay: `${280 + i * 170}ms` }}>
                    →
                  </span>
                )}
                <span
                  className="animate-tile-in flex gap-1"
                  style={{ animationDelay: `${280 + i * 170}ms` }}
                >
                  {word.split('').map((ch, j) => {
                    const changed = i > 0 && CHANGED_AT[i - 1] === j
                    return (
                      <span
                        key={j}
                        className={`flex h-9 w-9 items-center justify-center rounded-md border font-mono text-sm font-bold uppercase sm:h-10 sm:w-10 ${
                          changed
                            ? 'animate-tile-pop border-emerald-400 bg-emerald-500 text-white shadow-[0_0_18px_rgba(16,185,129,0.55)]'
                            : 'border-border bg-card text-foreground shadow-sm'
                        }`}
                        style={changed ? { animationDelay: `${360 + i * 170}ms` } : undefined}
                      >
                        {ch}
                      </span>
                    )
                  })}
                </span>
              </span>
            ))}
            <span
              className="animate-tile-in ml-2 rounded-full bg-emerald-500/15 px-2.5 py-1 text-sm font-bold text-emerald-500"
              style={{ animationDelay: '1100ms' }}
            >
              par 4
            </span>
          </div>

          <Link
            to="/play"
            className="animate-tile-in inline-flex items-center gap-2 rounded-full bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground shadow-[0_8px_30px_rgba(129,140,248,0.45)] transition-transform hover:scale-[1.03] hover:opacity-95 active:scale-95"
            style={{ animationDelay: '420ms' }}
          >
            Play today’s ladder
          </Link>
        </div>
      </div>
    </>
  )
}
