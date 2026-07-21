/**
 * Name cleaning — run once at import, on the way in.
 *
 * Uploaded names arrive dressed: "Mr. Somchai Jaidee Jr.", "นายสมชาย  ใจดี",
 * 'SOMCHAI "TUI" JAIDEE'. The decorations are noise for every consumer — they drag the
 * matcher's trigram scores down by a constant, they make two spellings of the same person
 * look like two people to the dedup key, and they read badly in a grid.
 *
 * The cleaned name is what gets STORED, in the name column itself — there is no raw twin.
 * That is a deliberate reversal of the earlier design (a `_clean` column beside the original)
 * and it comes with a hard constraint: **every rule here must be one we are willing to apply
 * with no undo.** A cleaned name is now the only record of what the file said, so a rule that
 * guesses is a rule that silently destroys data on the row it guesses wrong.
 *
 * That constraint is why there is no de-middle rule. Dropping the tokens between the first and
 * last is the one genuinely lossy thing this module used to do — it is simply wrong for a
 * two-word Thai surname ("ณ อยุธยา") or a Spanish double surname ("Maria del Carmen Garcia"),
 * and it was only ever survivable because the original sat in the next column. It doesn't any
 * more, so the rule is gone. Titles, suffixes and nicknames are still stripped: those are
 * decorations *around* a name, not part of one, and re-deriving them was never possible anyway.
 *
 * The result is lower-cased. Case carries no identity for matching — "SOMCHAI" and "Somchai"
 * are one person — and folding it on the way in means the dedup key, the matcher and the grid
 * all read one spelling rather than each lower-casing defensively at their own end.
 *
 * The rules, in order:
 *   1. normalize   NFKC, kill zero-width/NBSP, collapse runs of spaces, trim
 *   2. de-decorate strip quotes and bracketed nicknames:  Somchai "Tui" Jaidee → Somchai Jaidee
 *   3. de-title    drop leading honorifics, spaced or attached: นายสมชาย → สมชาย
 *   4. de-suffix   drop trailing suffixes: Jr., III, PhD
 *   5. case        fold to lower; Thai has no case and is unaffected
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
 * The full clean, for a person's name — and the only spelling of it that gets stored.
 *
 * Returns null when nothing survives (a "name" that was only a title) — the same "no value"
 * the parser uses for an empty cell. A caller that treats null as "use the raw text instead"
 * would be storing the very decoration this strips, so callers drop the row instead.
 *
 * Every token between the first and the last is kept. See the module header: without a raw
 * column to fall back on, a rule that guesses which tokens matter is one that loses data it
 * cannot return.
 */
export function cleanPersonName(raw: string | null | undefined): string | null {
  const tidied = tidyText(raw);
  if (tidied === null) return null;

  const decorated = deDecorate(tidied);
  if (decorated === "") return null;

  const tokens = deSuffix(deTitle(decorated.split(" ").filter(Boolean)));
  const cleaned = tokens.join(" ").trim().toLowerCase();
  return cleaned === "" ? null : cleaned;
}

/** Whether cleaning would change the text — drives the preview's "N names will be cleaned" note. */
export const wasCleaned = (raw: string | null, clean: string | null): boolean => (raw ?? "") !== (clean ?? "");
