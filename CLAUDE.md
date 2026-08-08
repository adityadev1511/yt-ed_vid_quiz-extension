\# Project: YouTube Learning Quiz Tool



\## What this is

A web app where a user submits an educational YouTube video URL and receives an

AI-generated quiz that tests CONCEPTUAL UNDERSTANDING AND TRANSFER, not recall of

the video's exact examples. The app also suggests "go deeper" topics after the quiz.

Future phases add playlist-level quizzes (RAG) and a browser extension.



\## Owner

Solo developer (Aditya), final-year student, Windows machine, limited time

(placement season). Prior production experience: Next.js 14, Supabase, pgvector,

LLM gateway patterns (Gemini + Groq fallback), TypeScript, Node.js.



\## Architecture decisions — ALREADY MADE, do not relitigate

\- Next.js 14 App Router, TypeScript, Tailwind. API routes as backend. NO separate

&#x20; Express server.

\- Supabase: Postgres + Auth + RLS. NO MongoDB. Chosen because access patterns are

&#x20; join-heavy (users -> attempts -> quizzes -> questions) and relational integrity

&#x20; matters for a solo dev.

\- NO RAG in MVP. A single video transcript fits in one LLM context window.

&#x20; RAG activates only in Phase 2 (playlists). Do not add embeddings, chunk retrieval,

&#x20; or vector search to Phase 1 code paths.

\- pgvector reserved for Phase 2: transcript\_chunks.embedding is vector(768),

&#x20; NULLABLE, left null in Phase 1. Nomic embeddings + HNSW index added in Phase 2 only.

\- LLM: Gemini 2.5 Flash primary, Groq (Llama) fallback, thin gateway module with

&#x20; retry + fallback. Structured JSON output, validated with Zod at the boundary.

&#x20; Malformed LLM output must fail loudly, never render broken UI.

\- NO Redis/caching in MVP. Quiz caching is done at the DB level (see below).

\- Deployment target: Railway (app) + Supabase cloud (DB).



\## Core pipeline (Phase 1)

Video URL -> transcript service (library fetch, manual-paste fallback in UI)

\-> ONE structured LLM call that BOTH classifies and generates

\-> branch: educational => render quiz; not educational => "out of scope" card

&#x20;  showing the classifier's reason.



\## The educational gate — critical design

\- Classification is part of the SAME structured output as the quiz, first fields

&#x20; in the schema. The model commits to classification before generating.

\- Criterion is CONTENT FUNCTION, not genre: "does this transcript teach concepts,

&#x20; skills, or frameworks a viewer could be tested on?" A comedy-writing lecture by

&#x20; a comedian IS educational. A comedy entertainment show is NOT.

\- Output includes confidence 0-1. Below a threshold (\~0.65), do NOT hard-reject:

&#x20; offer the quiz with a "loosely structured content" caveat. Binary gates on fuzzy

&#x20; categories are a known failure mode here.

\- is\_educational and edu\_confidence are stored on the videos table (property of

&#x20; the content), so repeat submissions of the same video skip the gate.



\## Structured output schema (shape — exact Zod types in code)

{

&#x20; is\_educational: boolean,

&#x20; confidence: number,          // 0-1

&#x20; detected\_topics: string\[],

&#x20; reason: string,              // shown to user on rejection

&#x20; quiz: null | {

&#x20;   questions: \[{

&#x20;     question: string,

&#x20;     options: string\[4],

&#x20;     correct\_index: number,

&#x20;     explanation: string,

&#x20;     difficulty: "easy" | "medium" | "hard",

&#x20;     concept\_tag: string      // enables per-concept analytics later

&#x20;   }],

&#x20;   deeper\_topics: string\[]    // the "go deeper" suggestions

&#x20; }

}



\## Database schema (Phase 1 creates all tables; embedding stays null)

users(id, email, created\_at)                          -- via Supabase Auth

playlists(id, yt\_playlist\_id, title)                  -- table exists, unused in MVP

videos(id, playlist\_id FK nullable, yt\_video\_id, title,

&#x20;      is\_educational, edu\_confidence)

transcript\_chunks(id, video\_id FK, chunk\_index, content,

&#x20;      embedding vector(768) NULL)                    -- null until Phase 2

quizzes(id, video\_id FK, model\_used, deeper\_topics jsonb, created\_at)

questions(id, quiz\_id FK, question, options jsonb, correct\_index,

&#x20;      explanation, difficulty, concept\_tag)

attempts(id, user\_id FK, quiz\_id FK, answers jsonb, score, created\_at)



Notes:

\- Quizzes are CACHED per video: same video => reuse existing quiz, with a

&#x20; user-facing "regenerate" option. Saves LLM calls.

\- attempts.answers as jsonb is a deliberate denormalization for MVP speed;

&#x20; promote to a rows table only if Phase 2 analytics demand it.

\- model\_used is recorded on every quiz for later Gemini-vs-Groq quality comparison.



\## Division of labor — IMPORTANT, enforce this

The quiz-generation PROMPT (the text sent to the LLM) and the quality RUBRIC are

authored and iterated by the developer personally. This is a deliberate learning

decision. When work touches the prompt:

\- Build the harness, eval script, and schema around it.

\- Give critique on prompt drafts when asked.

\- DO NOT write or rewrite the prompt wholesale. Suggest, don't replace.



\## Working style

\- Small vertical slices. Each phase ends with something runnable.

\- Explain non-obvious decisions in 1-2 sentences as you make them.

\- Prefer boring, standard solutions. No speculative abstractions.

\- Ask before adding any dependency not listed above.

\- This is a resume project: code should be readable and defensible in an

&#x20; interview, not clever.

