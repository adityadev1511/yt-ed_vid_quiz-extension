# Learn, Don't Watch

Paste an educational YouTube video's URL (or its transcript) and get a quiz
that tests whether you actually *understood* it — not whether you remember it.
Every medium and hard question forces you to apply the video's concepts to
situations the video never showed you.

**Live app:** https://yt-ed-vid-quiz-extension.vercel.app
*Built solo in 48 hours for the Zerops Challenge, August 2026.*

## The argument

Passive watching creates the illusion of learning. You finish a tutorial,
everything "makes sense," and a week later you can't apply any of it. Most
quiz generators make this worse: they ask you to recall the video's own
examples, which rewards recognition — the exact thing that feels like
understanding but isn't.

This tool takes the opposite stance:

- **Transfer over recall.** Questions present *new* scenarios that require
  applying the concepts taught. The video's own examples are banned from
  appearing in questions. Two easy questions may be recognition-level
  warm-ups; the mediums and the hard question are strictly transfer.
- **Diagnostic distractors.** Every wrong option embodies a specific,
  plausible misconception — chosen by asking "what exact misunderstanding
  would lead someone here?"
- **It says no.** An LLM classification gate checks whether the transcript
  actually *teaches* anything before generating. Song lyrics and
  entertainment get a polite refusal with the model's reasoning. The
  criterion is content function, not genre — a comedian's lecture on
  comedy writing passes; a comedy show doesn't. Borderline content
  (podcasts, talks) gets the quiz with an honest "loosely structured
  content" caveat instead of a hard reject.

## How it works

YouTube URL → server-side caption fetch (with a paste fallback that always
works) → cache lookup by video ID or transcript hash → on a miss, one
structured LLM call that both classifies and generates (the model must commit
to the classification before producing questions) → Zod validation at the
boundary → quiz UI with explanations and "go deeper" topic suggestions.

**Stack:** Next.js 14 (App Router, API routes as backend), TypeScript,
Tailwind, and an optional PostgreSQL quiz cache (Neon) — `pg` directly, no
ORM, one table. Deployed on Vercel,
auto-deploying from `main`; originally deployed on Zerops for the challenge.
Built end-to-end with Claude Code as the coding agent, with deploy-and-verify
loops on the live URL after every feature.

**LLM gateway:** Gemini 2.5 Flash primary, openai/gpt-oss-120b on Groq as
fallback, with strict JSON schema enforcement on both paths, per-provider
timeouts sized at ~2x measured worst-case latency, a bounded total request
budget, and structured logging of every provider decision — including a
demotion warning whenever a request is served by the fallback.

## Engineering decisions worth defending

- **No RAG — deliberately.** A single video transcript fits in one context
  window; retrieval would be resume-driven architecture. Retrieval earns its
  place at playlist scale and not before, so the database is exactly one
  table today — no chunk table, no embedding column, nothing speculative
  waiting to be used.
- **The fallback was measured, not assumed.** The original Llama 3.3
  fallback produced definition-style questions that violated the transfer
  rule. Using a FORCE_FALLBACK test flag and a written quality rubric, the
  fallback was A/B'd and upgraded to gpt-oss-120b with a compressed
  constraint block — bringing it to near-parity with the primary. The
  model_used field recorded per quiz made the comparison trivial.
- **Timeouts were tuned from data.** Five measured Gemini runs
  (17.5–21.6s) showed the initial 25s ceiling left ~3s of headroom —
  ordinary variance would have silently demoted requests to the fallback.
  Ceilings were resized to 2x observed worst case.
- **Failures are loud internally, human externally.** Every failure path
  renders a plain-language message with a retry action; raw errors go
  only to server logs. Fetch failures, provider demotions, and gate
  decisions are all logged server-side.
- **The cache is an optimisation, never a dependency.** Quizzes are stored in
  Postgres keyed on video ID *or* transcript hash, so the two entry points
  share one cache — a hand-pasted transcript hits the row a URL fetch created.
  A repeat submission returns in ~0ms instead of ~20s. But every database call
  swallows its own failures and returns null, so an unreachable database
  degrades the app to precisely its stateless behaviour. Verified by pointing
  `DATABASE_URL` at a black-hole address: full quiz, HTTP 200, both failures
  logged, nothing user-visible.
- **Two bugs that only showed up under adversarial testing.** A database that
  *hangs* rather than refuses charged every request the connect timeout twice,
  once on read and once on write — 28.7s against a 20.4s stateless baseline.
  A circuit breaker now skips the database for 30s after a connectivity
  failure (and only a connectivity failure — a unique violation is a healthy
  database answering correctly), cutting the worst case to under 1.5s.
  Separately, a video whose transcript changed collided with the
  `yt_video_id` unique constraint on write, which would have left that video
  permanently uncacheable and re-generating at 20s forever; the write is now
  a delete-then-upsert inside a transaction, so the cache self-heals. Cached
  rows are also re-validated against the Zod schema on read — a stale shape
  is treated as a miss rather than rendered.

## Honest limitations

- **Server-side transcript fetching is best-effort by design.** It
  currently works from our deployment, but YouTube blocks datacenter IPs
  unpredictably — so the UI treats fetch as an upgrade, not a dependency,
  and degrades to a paste flow that always works. The real fix is
  architectural: a browser extension fetches captions client-side on the
  user's own IP — which is the next phase, not a workaround.
- **Free-tier LLM quotas are a designed-for constraint.** When the primary
  provider's quota is exhausted, the rubric-verified fallback carries the
  app; every quiz records which model served it.
- **Paste mode accepts any educational text by design.** Provenance
  ("is this really from a video?") cannot be reliably detected from pasted
  text without rejecting legitimate transcripts; it is enforced
  structurally in the URL flow and, in the next phase, the extension.
- **Classifier confidence is coarsely calibrated.** The gate's binary
  decisions are reliable; its confidence scores were calibrated with
  prompt guidance rather than real measurement.
- **A cached quiz is the same quiz.** Repeat submissions of the same video or
  transcript return the stored questions, not new ones — a Regenerate control
  forces a fresh call and overwrites the cached row. That is the intended
  trade, since the LLM call is the expensive part, but it does mean two people
  quizzing the same video see identical questions.

## Where this goes

1. **Browser extension** — one-click quizzing on any video, captions
   grabbed client-side (solves transcript acquisition permanently), quiz
   offered right when the video ends.
2. **Playlist-level quizzes** — course-scale understanding checks; this is
   where retrieval finally earns its place (chunking, embeddings, pgvector)
   and the schema grows past one table.
3. **Concept-level learning history** — per-question concept tags already
   exist in the schema; wrong answers become a map of what you don't yet
   own, driving personalized "go deeper" suggestions.

## Running locally

```bash
npm ci
cp .env.example .env.local   # add your GEMINI_API_KEY and GROQ_API_KEY
npm run dev
```

The quiz cache is optional. Leave `DATABASE_URL` unset and the app runs
statelessly, generating every time. To enable it, set `DATABASE_URL` and
create the table once:

```bash
npm run migrate              # one-time, run manually — never on boot
```

`FORCE_FALLBACK=true` skips the primary provider — useful for testing
fallback quality without burning primary quota.

### The one table

```
quizzes(id, yt_video_id unique nullable, transcript_hash unique,
        quiz_json jsonb, model_used, is_educational, edu_confidence,
        created_at)
```

`quiz_json` holds the whole validated LLM response rather than just the
questions, so an "out of scope" verdict can be re-rendered without another
call. `is_educational` and `edu_confidence` are denormalised into columns
because they are properties of the *content*, not of any one quiz.
