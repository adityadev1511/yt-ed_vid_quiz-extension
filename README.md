# Watching Isn't Learning

Paste an educational YouTube video's URL (or its transcript) and get a quiz
that tests whether you actually *understood* it — not whether you remember it.
Every medium and hard question forces you to apply the video's concepts to
situations the video never showed you.

**Live app:** https://app-2b7a-3000.prg1.zerops.app
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
works) → one structured LLM call that both classifies and generates (the
model must commit to the classification before producing questions) → Zod
validation at the boundary → quiz UI with explanations and "go deeper"
topic suggestions.

**Stack:** Next.js 14 (App Router, API routes as backend), TypeScript,
Tailwind. Deployed on Zerops (zerops.yml, zcli push pipeline). Built
end-to-end with Claude Code as the coding agent, with deploy-and-verify
loops on the live URL after every feature.

**LLM gateway:** Gemini 2.5 Flash primary, openai/gpt-oss-120b on Groq as
fallback, with strict JSON schema enforcement on both paths, per-provider
timeouts sized at ~2x measured worst-case latency, a bounded total request
budget, and structured logging of every provider decision — including a
demotion warning whenever a request is served by the fallback.

## Engineering decisions worth defending

- **No RAG — deliberately.** A single video transcript fits in one context
  window; retrieval would be resume-driven architecture. The schema is
  RAG-ready for the playlist phase, but no embeddings are computed today.
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

## Where this goes

1. **Browser extension** — one-click quizzing on any video, captions
   grabbed client-side (solves transcript acquisition permanently), quiz
   offered right when the video ends.
2. **Playlist-level quizzes** — course-scale understanding checks; this is
   where the RAG-ready schema activates (chunking, embeddings, pgvector).
3. **Concept-level learning history** — per-question concept tags already
   exist in the schema; wrong answers become a map of what you don't yet
   own, driving personalized "go deeper" suggestions.

## Running locally

```bash
npm ci
cp .env.example .env.local   # add your GEMINI_API_KEY and GROQ_API_KEY
npm run dev
```

`FORCE_FALLBACK=true` skips the primary provider — useful for testing
fallback quality without burning primary quota.
