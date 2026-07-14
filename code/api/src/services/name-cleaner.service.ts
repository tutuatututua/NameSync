/**
 * Name cleaning — run once at import, on the way in.
 *
 * Uploaded names arrive dressed: "Mr. Somchai J. Jaidee Jr.", "นายสมชาย  ใจดี",
 * 'SOMCHAI "TUI" JAIDEE'. The decorations are noise for every consumer — they drag the
 * matcher's trigram scores down by a constant, they make two spellings of the same person
 * look like two people to the dedup key, and they read badly in a grid.
 *
 * So each name is cleaned when the file is parsed, and the result is stored *alongside*
 * the original in a `_clean` column. The raw text is never modified: cleaning rules are
 * guesses (a "middle" token may be half of a two-word surname), and a guess you can't undo
 * is a data-loss bug waiting for the one row it gets wrong. Keeping both means a better
 * rule tomorrow is a backfill, not a re-upload.
 *
 * Everything downstream — the import preview, the grid, the matcher — reads `_clean` and
 * falls back to the raw name when it's absent (rows imported before this existed).
 *
 * The rules, in order:
 *   1. normalize   NFKC, kill zero-width/NBSP, collapse runs of spaces, trim
 *   2. de-decorate strip quotes and bracketed nicknames:  Somchai "Tui" Jaidee → Somchai Jaidee
 *   3. de-title    drop leading honorifics, spaced or attached: นายสมชาย → สมชาย
 *   4. de-suffix   drop trailing suffixes: Jr., III, PhD
 *   5. de-middle   keep only the first and last token: Somchai J. Jaidee → Somchai Jaidee
 *   6. case        Title Case a Latin name that shouted or whispered; leave mixed case alone
 */

/** Honorifics, dots and spaces removed, lower-cased. Latin + Thai. */
const HONORIFICS = new Set([
  // Latin
  "mr", "mrs", "ms", "miss", "mstr", "master", "dr", "prof", "professor",
  "sir", "madam", "madame", "mdm", "lady", "rev", "hon", "khun",
  // Thai (bare() has already removed the dots, so "น.ส." arrives here as "นส")
  "นาย", "นาง", "นางสาว", "นส", "ดช", "ดญ", "ดร", "คุณ", "ท่าน", "ศ", "รศ", "ผศ",
]);

/** Thai honorifics also come *attached* to the name — "นายสมชาย" is one token, not two.
 *  Longest first: "นางสาว" must be tried before "นาง", or it strips the wrong prefix. */
const THAI_ATTACHED = ["นางสาว", "นาย", "นาง", "คุณ", "ดร.", "ด.ช.", "ด.ญ.", "น.ส."].sort(
  (a, b) => b.length - a.length
);

/** Trailing suffixes, dots removed, lower-cased. */
const SUFFIXES = new Set([
  "jr", "sr", "ii", "iii", "iv", "v",
  "phd", "md", "dds", "esq", "cpa", "mba", "rn", "do",
]);

/** Zero-width space / non-joiner / joiner / BOM — invisible, and they break every compare. */
const INVISIBLE = /[\u200B-\u200D\uFEFF]/g;
/** Every flavour of non-breaking / typographic space, folded to a plain one. */
const ODD_SPACE = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g;

/** A token stripped to letters/digits, for comparing against the sets above. */
const bare = (token: string): string => token.normalize("NFKC").replace(/[.。]/g, "").toLowerCase();

/** Whether the token is written in Thai script (so casing rules don't apply to it). */
const isThai = (token: string): boolean => /\p{Script=Thai}/u.test(token);

/**
 * Whitespace and invisible characters, and nothing else. This is the whole treatment for
 * text that isn't a person's name — a company name gets this and stops here, because "Mr"
 * inside a company's name is part of the company's name.
 */
export function tidyText(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const s = raw
    .normalize("NFKC")
    .replace(INVISIBLE, "")
    .replace(ODD_SPACE, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s === "" ? null : s;
}

/** Strip nicknames and stray punctuation: 'Somchai "Tui" (Toy) Jaidee,' → 'Somchai Jaidee'. */
function deDecorate(s: string): string {
  return s
    // A nickname is bracketed, or quoted *inside* the name. A wholly-quoted name is not a
    // nickname — that's just a CSV that kept its quotes — so it's unwrapped, not dropped.
    .replace(/[([{<“‘].*?[)\]}>”’]/g, " ")
    .replace(/(^|\s)"[^"]*"(\s|$)/g, " ")
    .replace(/(^|\s)'[^']*'(\s|$)/g, " ")
    .replace(/^["'“‘]+|["'”’]+$/g, "")
    // separators that carry no meaning between the parts of a name
    .replace(/[,;:|"]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Drop the leading run of honorifics, spaced ("นาย สมชาย") or attached ("นายสมชาย"). */
function deTitle(tokens: string[]): string[] {
  const out = [...tokens];

  while (out.length > 0 && HONORIFICS.has(bare(out[0]))) out.shift();

  if (out.length > 0) {
    const first = out[0].normalize("NFKC");
    for (const prefix of THAI_ATTACHED) {
      // Only when something substantial is left: "นาย" alone is a title, not a name, and a
      // 1-character remainder is far more likely a real word that happens to start this way.
      if (first.startsWith(prefix) && first.length - prefix.length >= 2) {
        out[0] = first.slice(prefix.length);
        break;
      }
    }
  }
  return out;
}

/** Drop the trailing run of suffixes: "Jaidee Jr. PhD" → "Jaidee". */
function deSuffix(tokens: string[]): string[] {
  const out = [...tokens];
  // Never strip the last token standing: someone recorded as only "Miss" or only "V" keeps
  // the one token they have, so a row with a raw name never cleans down to nothing.
  while (out.length > 1 && SUFFIXES.has(bare(out[out.length - 1]))) out.pop();
  return out;
}

/**
 * Keep the first and last token, drop what's between — middle names and initials.
 *
 * This is the one lossy rule, and it *is* wrong for a two-word surname ("ณ อยุธยา") or a
 * Spanish double surname. Survivable only because the raw name is still stored: the clean
 * column is for matching and display, and the row this mangles is one query from its
 * original text. Don't reach for this function anywhere the raw name isn't kept.
 */
function deMiddle(tokens: string[]): string[] {
  return tokens.length <= 2 ? tokens : [tokens[0], tokens[tokens.length - 1]];
}

/** "SOMCHAI" / "somchai" → "Somchai". "McKinsey" and Thai are left alone — a name that
 *  already carries case information knows better than this function does. */
function fixCase(token: string): string {
  if (isThai(token) || !/\p{L}/u.test(token)) return token;
  const letters = token.replace(/\P{L}/gu, "");
  const shouted = letters === letters.toUpperCase();
  const whispered = letters === letters.toLowerCase();
  if (!shouted && !whispered) return token;

  // Capitalise after each internal boundary too: o'brien → O'Brien, mary-jane → Mary-Jane.
  return token
    .toLowerCase()
    .replace(/(^|[-'’.])(\p{L})/gu, (_m, sep: string, ch: string) => sep + ch.toUpperCase());
}

/**
 * The full clean, for a person's name. Returns null when nothing survives (a "name" that
 * was only a title) — the same "no value" the parser uses for an empty cell.
 */
export function cleanPersonName(raw: string | null | undefined): string | null {
  const tidied = tidyText(raw);
  if (tidied === null) return null;

  const decorated = deDecorate(tidied);
  if (decorated === "") return null;

  const tokens = deMiddle(deSuffix(deTitle(decorated.split(" ").filter(Boolean))));
  const cleaned = tokens.map(fixCase).join(" ").trim();
  return cleaned === "" ? null : cleaned;
}

/** Whether cleaning actually changed anything — drives the "N names were cleaned" note. */
export const wasCleaned = (raw: string | null, clean: string | null): boolean => (raw ?? "") !== (clean ?? "");

/** The name to *use* for a row that may predate cleaning (its clean column is still null). */
export const effectiveName = (clean: string | null, raw: string | null): string | null =>
  clean ?? cleanPersonName(raw);
