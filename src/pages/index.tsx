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

const STEPS = [
  {
    title: '1. Track a repo',
    body: 'Paste any public GitHub repo and your stack — say, tiangolo/fastapi and Python, backend.',
  },
  {
    title: '2. Get issues scored',
    body: 'Issue Radar pulls the repo\u2019s open issues and scores each one for fit as a first bug-fix, with an AI judge on the best fits and a deterministic score as fallback.',
  },
  {
    title: '3. Triage the best',
    body: 'Work the queue highest-score first: open an issue on GitHub, save it for later, or dismiss it. Scans repeat hourly and a 9am digest emails new issues scored 70+.',
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
          Issue Radar
        </p>
        <h1 className="mb-4 max-w-2xl text-4xl font-bold tracking-tight text-foreground sm:text-5xl">
          Find your first bug-fix, not just any issue
        </h1>
        <p className="mb-8 max-w-md text-muted-foreground">
          Issue Radar scores a repo&apos;s open GitHub issues for how well they fit
          as a first contribution for your stack, then queues the best ones for
          triage.
        </p>
        <Link
          to="/home"
          className="mb-12 inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
        >
          Enter the app
        </Link>
        <div className="grid w-full max-w-3xl gap-4 text-left sm:grid-cols-3">
          {STEPS.map((step) => (
            <div
              key={step.title}
              className="rounded-lg border border-border bg-card p-4"
            >
              <h2 className="mb-1 text-sm font-semibold text-foreground">{step.title}</h2>
              <p className="text-sm text-muted-foreground">{step.body}</p>
            </div>
          ))}
        </div>
        <p className="mt-10 max-w-md text-sm text-muted-foreground">
          No repo in mind? Start with <code>tiangolo/fastapi</code> — sign in with
          GitHub or Google and your first scan runs right away.
        </p>
      </div>
    </>
  )
}
