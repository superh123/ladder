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

export default function Landing() {
  return (
    <>
      <Seo {...seo} path="/" />
      <div
        data-testid="static-landing"
        className="flex min-h-screen flex-col items-center justify-center px-6 py-16 text-center"
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
        <div className="mb-8 flex items-center gap-1.5" aria-label="Example ladder: cold to warm in four steps">
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
          className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
        >
          Play today’s ladder
        </Link>
      </div>
    </>
  )
}
