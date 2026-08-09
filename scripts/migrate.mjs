/**
 * One-time migration. Run manually: `npm run migrate`.
 *
 * Deliberately not wired into boot — an app that migrates on start will happily
 * run a schema change during a rolling restart, and this is a hackathon deadline,
 * not a place to debug that.
 */
import { readFileSync } from "node:fs";
import { Client } from "pg";

// Next loads .env.local for the app, but a standalone script gets nothing.
// Parsed by hand rather than adding dotenv for one file.
function loadLocalEnv(file = ".env.local") {
  let contents;
  try {
    contents = readFileSync(file, "utf8");
  } catch {
    return; // Absent in production, where the platform supplies real env vars.
  }
  for (const line of contents.split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!match) continue;
    const [, key, rawValue] = match;
    // Existing environment always wins, so a shell override still works.
    if (process.env[key] !== undefined) continue;
    process.env[key] = rawValue.replace(/^["']|["']$/g, "");
  }
}

const DDL = `
create table if not exists quizzes (
  id              bigserial primary key,
  -- Nullable: the paste flow has no video. Unique so one video keeps one quiz.
  yt_video_id     text unique,
  -- The cache key that always exists; sha256 of the trimmed transcript.
  transcript_hash text not null unique,
  -- The whole validated LLM response, not just the questions: the rejection
  -- fields are needed to re-render an "out of scope" verdict without a new call.
  quiz_json       jsonb not null,
  model_used      text not null,
  is_educational  boolean not null,
  edu_confidence  real not null,
  created_at      timestamptz not null default now()
);
`;

loadLocalEnv();

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is not set. Put it in .env.local or export it, then re-run.");
  process.exit(1);
}

const client = new Client({ connectionString, connectionTimeoutMillis: 10_000 });

try {
  await client.connect();
  await client.query(DDL);

  const { rows } = await client.query(
    `select column_name, data_type, is_nullable
       from information_schema.columns
      where table_name = 'quizzes'
      order by ordinal_position`,
  );
  console.log("migration ok — quizzes:");
  for (const r of rows) {
    console.log(`  ${r.column_name.padEnd(16)} ${r.data_type}${r.is_nullable === "YES" ? " null" : ""}`);
  }
} catch (err) {
  console.error(`migration failed: ${err.message}`);
  process.exit(1);
} finally {
  await client.end();
}
