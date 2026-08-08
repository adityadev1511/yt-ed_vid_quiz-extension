import { z } from "zod";

/**
 * The contract between the LLM and the app. This is the ONLY place the shape is
 * defined for runtime validation — anything the model returns that does not fit
 * here fails loudly at the API boundary rather than rendering a broken quiz.
 *
 * Field order matters conceptually: classification fields come first so the model
 * commits to is_educational/confidence before it generates any questions.
 */

export const QuestionSchema = z.object({
  question: z.string().min(1),
  options: z.array(z.string().min(1)).length(4),
  correct_index: z.number().int().min(0).max(3),
  explanation: z.string().min(1),
  difficulty: z.enum(["easy", "medium", "hard"]),
  concept_tag: z.string().min(1),
});

export const QuizSchema = z.object({
  questions: z.array(QuestionSchema).min(1),
  deeper_topics: z.array(z.string().min(1)),
});

export const LlmResponseSchema = z.object({
  is_educational: z.boolean(),
  confidence: z.number().min(0).max(1),
  detected_topics: z.array(z.string()),
  reason: z.string().min(1),
  // The model may omit `quiz` entirely when rejecting; normalise undefined -> null
  // so downstream code only ever branches on null.
  quiz: QuizSchema.nullish().transform((v) => v ?? null),
});

export type Question = z.infer<typeof QuestionSchema>;
export type Quiz = z.infer<typeof QuizSchema>;
export type LlmResponse = z.infer<typeof LlmResponseSchema>;

/** Below this, we still offer the quiz but with a "loosely structured content" caveat. */
export const CONFIDENCE_THRESHOLD = 0.65;

/**
 * The same shape expressed for Gemini's `responseSchema` (OpenAPI subset).
 * Kept hand-written and adjacent to the Zod schema on purpose: auto-deriving it
 * would be a speculative abstraction for one schema. If you edit one, edit both.
 *
 * Deliberately looser than the Zod schema (no array length bounds, no index range)
 * — Zod is the enforcement layer; this just steers generation.
 */
export const GEMINI_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    is_educational: { type: "boolean" },
    confidence: { type: "number" },
    detected_topics: { type: "array", items: { type: "string" } },
    reason: { type: "string" },
    quiz: {
      type: "object",
      nullable: true,
      properties: {
        questions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              question: { type: "string" },
              options: { type: "array", items: { type: "string" } },
              correct_index: { type: "integer" },
              explanation: { type: "string" },
              difficulty: { type: "string", enum: ["easy", "medium", "hard"] },
              concept_tag: { type: "string" },
            },
            required: [
              "question",
              "options",
              "correct_index",
              "explanation",
              "difficulty",
              "concept_tag",
            ],
            propertyOrdering: [
              "question",
              "options",
              "correct_index",
              "explanation",
              "difficulty",
              "concept_tag",
            ],
          },
        },
        deeper_topics: { type: "array", items: { type: "string" } },
      },
      required: ["questions", "deeper_topics"],
      propertyOrdering: ["questions", "deeper_topics"],
    },
  },
  required: ["is_educational", "confidence", "detected_topics", "reason"],
  propertyOrdering: [
    "is_educational",
    "confidence",
    "detected_topics",
    "reason",
    "quiz",
  ],
} as const;
