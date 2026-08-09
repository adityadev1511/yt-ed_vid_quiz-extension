/**
 * YouTube URL parsing.
 *
 * Kept separate from the fetching code because it is pure and worth testing on
 * its own — every odd share-link format users paste ends up here.
 */

/** YouTube video IDs are always 11 chars of base64url. */
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/** Path forms where the ID is the segment straight after the prefix. */
const PATH_PREFIXES = new Set(["shorts", "embed", "live", "v", "e"]);

function asId(value: string | null | undefined): string | null {
  return value && VIDEO_ID.test(value) ? value : null;
}

function isYouTubeHost(host: string): boolean {
  return (
    host === "youtube.com" ||
    host.endsWith(".youtube.com") ||
    host === "youtube-nocookie.com" ||
    host.endsWith(".youtube-nocookie.com")
  );
}

/**
 * Extract a video ID from anything a user is likely to paste: watch?v=,
 * youtu.be/, /shorts/, /embed/, /live/, extra query params, no scheme, or a
 * bare ID. Returns null when nothing usable is present.
 *
 * Note a bare 11-char word (e.g. "programming") parses as an ID. That is the
 * accepted cost of supporting bare IDs — the fetch simply fails and the user
 * lands on the paste fallback, which is never a dead end.
 */
export function extractVideoId(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  if (VIDEO_ID.test(raw)) return raw;

  let url: URL;
  try {
    // Users paste "youtube.com/watch?v=..." without a scheme constantly.
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^www\./i, "").toLowerCase();
  const segments = url.pathname.split("/").filter(Boolean);

  // youtu.be/<id> — the ID is the whole path.
  if (host === "youtu.be") return asId(segments[0]);

  if (!isYouTubeHost(host)) return null;

  // /shorts/<id>, /embed/<id>, /live/<id>, /v/<id>
  if (segments.length >= 2 && PATH_PREFIXES.has(segments[0].toLowerCase())) {
    return asId(segments[1]);
  }

  // /watch?v=<id>, and any other form that carries ?v=
  return asId(url.searchParams.get("v"));
}
