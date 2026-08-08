/**
 * Prompt assembly.
 *
 * The final prompt is three parts, concatenated in this order:
 *
 *   1. PROMPT_BODY      <- YOU write this. The actual instructions/rubric.
 *   2. SCHEMA_CONTRACT  <- machine-shape rules. Keep in sync with lib/schema.ts.
 *   3. the transcript
 *
 * The only section you should need to edit is PROMPT_BODY.
 */

/**
 * ============================================================
 * PROMPT BODY — AUTHORED BY ADITYA
 * ============================================================
 *
 * Everything between the backticks below is yours. Nothing else in this repo
 * writes to it. Iterate here.
 *
 * Scope reminders (structural only — these are notes to you, not draft text,
 * do not paste them into the prompt):
 *   - the classification criterion (content FUNCTION, not genre)
 *   - what "confidence" means and how to calibrate it
 *   - the conceptual-understanding / transfer bar for questions
 *   - the anti-recall rule (no questions about the video's specific examples)
 *   - distractor quality, difficulty spread, concept_tag conventions
 *   - what belongs in deeper_topics
 *
 * While this is empty the pipeline still runs end-to-end — the model will get
 * only the schema contract and improvise, which is exactly the baseline you want
 * to measure your first draft against.
 */
export const PROMPT_BODY = `
ROLE
You are a quiz designer for educational YouTube videos. Your job is to test
whether the viewer genuinely understood the concepts taught in the video —
not whether they remember its surface details. You are not a summarizer.

STEP 1 - CLASSIFY
First decide if this transcript is educational. The criterion is content
function, not genre: does this transcript teach concepts, skills, or
frameworks a viewer could be tested on? A comedy-writing lecture by a
comedian qualifies. An entertainment show does not. Set is_educational,
confidence (0-1), detected_topics, and reason accordingly. If not
educational, set quiz to null and stop.

STEP 2 - GENERATE THE QUIZ

Hard rules (never break these):
1. Exactly 5 multiple-choice questions: 2 easy, 2 medium, 1 hard.
2. Every question must pass the transfer test: it must be answerable by
   someone who understands the concept but never watched this video, and it
   must NOT be answerable by someone who only memorized the video's
   examples, definitions, or exact wording.
3. Never reuse the video's own examples, numbers, code snippets, or
   scenarios. Construct new situations that require applying the same
   concepts.
4. Stay strictly within the concepts the transcript actually teaches.
   Novel examples, familiar concepts - never new concepts.
5. Exactly 4 options per question, exactly one correct.

Distractors:
Each of the 3 wrong options must embody a specific, plausible
misconception - an answer that someone who half-understood the concept
would genuinely pick. Before writing each distractor, ask: "what exact
misunderstanding would lead a person here?" If you cannot name one, the
distractor is too weak. Never use joke options, obviously absurd options,
"all of the above," or "none of the above."

Explanation field (per question):
State why the correct answer is correct, AND why the most tempting
distractor is wrong - naming the misconception it represents. Never just
"the answer is B."

concept_tag (per question):
A 2-4 word tag naming the specific concept tested, drawn from the
transcript's actual topics. Reuse the same tag string for questions
testing the same concept.

deeper_topics:
3-5 adjacent concepts the video did NOT cover, that a curious viewer
should explore next. These extend the topic — they are not a summary of
what was watched. Phrase each as an inviting pointer, e.g.
"Integer overflow behavior - what happens when unsigned arithmetic wraps
around" rather than a bare keyword.

QUALITY STANDARD - one worked example:

Good Easy Level Question (for a C programming video covering signed and unsigned
integer types):
Identify the core difference in an unsigned int data type and a signed int data type.

Good Medium Level Question (for the same topic):
What scenarios can unsigned int be used instead of signed int ?

Good Hard Level question (for the same topic):

    unsigned int ui_one      =  1;
    signed int   i_one       =  1;
    signed short s_minus_one = -1;

    if (s_minus_one > ui_one) printf("A\\n");
    if (s_minus_one < i_one)  printf("B\\n");

  "What does this program print, and why?"
  Correct answer: both A and B. In the first comparison, the signed value
  is converted to unsigned (usual arithmetic conversions), so -1 becomes a
  very large unsigned value and compares greater than 1. The second
  comparison is between two signed values, so it behaves as expected.
  This is a good question because it forces the viewer to APPLY the
  conversion rules to code they have never seen.

Bad question (same topic):
  "What is the definition of an unsigned int?"
  This is bad because it can be answered by matching words from the video
  without understanding anything.

This example is from programming, but apply the same standard to any
domain - history, biology, marketing, anything: a good question forces
applying the concept to a new situation; a bad question rewards
memorizing a definition or the video's own example.

`;
/** ==================== END PROMPT BODY ==================== */

/**
 * Machine-shape rules only. This exists so the Groq fallback (which has no
 * response-schema enforcement) still emits parseable JSON. Semantics of the
 * fields belong in PROMPT_BODY, not here.
 */
const SCHEMA_CONTRACT = `
Return ONLY a single JSON object. No markdown fences, no prose before or after.

The object has exactly these top-level keys, in this order:
  is_educational: boolean
  confidence: number between 0 and 1
  detected_topics: array of strings
  reason: string, non-empty
  quiz: null, or an object

When quiz is an object it has exactly these keys:
  questions: non-empty array of question objects
  deeper_topics: array of strings

Each question object has exactly these keys:
  question: string
  options: array of EXACTLY 4 strings
  correct_index: integer 0-3, the index into options of the correct answer
  explanation: string
  difficulty: one of "easy", "medium", "hard"
  concept_tag: short string naming the concept the question tests

Decide is_educational and confidence BEFORE generating any questions.
`.trim();

export function buildPrompt(transcript: string): string {
  return [
    PROMPT_BODY.trim(),
    SCHEMA_CONTRACT,
    "TRANSCRIPT:",
    transcript.trim(),
  ]
    .filter(Boolean)
    .join("\n\n");
}
