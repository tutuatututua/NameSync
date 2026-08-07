import { UserCheck, UserSearch } from "lucide-react";
import {
  hasThai,
  matchReason,
  matchStrength,
  scoreQualifier,
  type ConnectedUploader,
} from "@extensions/contract";
import { Badge } from "@/components/ui/badge";
import { formatSimilarity } from "@/lib/format";

/**
 * "Are these two the same person?" for two names the app groups case-insensitively.
 *
 * Every owner name in the product is folded by case before it is grouped (`lower(...)` throughout
 * `network.model.ts`) and displayed as written, so "Win" and "win" are one roster everywhere else
 * and must be one person here too — otherwise a chip announces an importer who is the owner under a
 * different capitalisation.
 */
export function sameName(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * "Alex knows pornsak nakornthap — same surname, 100%." — one chip, and the four facts a reader
 * needs before they act on it: WHO to ask, WHICH of their friends earned the number, WHAT was
 * compared, and HOW CLOSE it came.
 *
 * It began as a name alone, which made every connection read equally certain. The percent came
 * next, then the unit (`surname 94%` rather than a bare `94%`), each closing a gap where two very
 * different claims were rendering identically. The friend's name closes the last and largest of
 * them.
 *
 *   confirmed   [✓ Alex › pornsak nakornthap · full name 100%]   green, UserCheck
 *   lead        [⌕ Alex › pornsak nakornthap · surname 92%]      amber, UserSearch
 *   no score    [⌕ Alex › pornsak nakornthap]                    amber, UserSearch
 *   no name     [⌕ Alex · surname 92%]                           amber, UserSearch
 *
 * ── WHY THE FRIEND'S NAME IS ON THE FACE (2026-08-07) ──
 *
 * The chip carried the owner, the unit and the score, and it was still unfalsifiable by the person
 * reading it. On a search result headed `duangkamol nakornthap`, `⌕ Anong Preecha · surname 100%`
 * says a run scored 100% on the surname and says NOTHING about who Anong's friend is — and the
 * whole content of a surname match is that the given names were never looked at. Anong's friend may
 * be `pornsak nakornthap`: a different person who shares a family name, which is the ordinary case
 * and the one the amber grading is warning about. The reader could not tell that from the row, so
 * the warning had nothing to attach to and every lead chip read as "Anong knows them".
 *
 * The field was on the payload the whole time (`ConnectedUploader.friend`, added 2026-08-03c) and
 * `ConnectionCard` on the company page has spelled it out since; only this chip dropped it. So this
 * is not a new disclosure, it is the same one arriving at the surface where the decision is
 * actually made — Search is where somebody scans fourteen contacts and picks who to email.
 *
 * It is the frozen name THE RUN SCORED, off the same result row as `similarity` and `mode`, never
 * the friend row's current name: the number was earned by that string, and pairing a renamed friend
 * with an old score attaches evidence to a name that never earned it. `friendAlt` — the same
 * person's other spelling as we hold it today — stays in the tooltip rather than joining the face,
 * because it is identity and not evidence, and a chip that renders both spellings of both people is
 * a card wearing a badge's clothes.
 *
 * ── What stays where it was ──
 *
 * THE OWNER STILL LEADS. It is the answer to "who do I ask", it is where the link goes, and it is
 * what the eye is scanning a column of chips for; the friend rides second, dimmed, in the slot the
 * score already established for supporting detail. `›` and not the `→` that `ConnectionCard` uses
 * between its two names — there the arrow means "was compared against", and these two are not two
 * sides of a comparison. Alex and Alex's friend are one side of it; the contact heading the row is
 * the other.
 *
 * NO "Lead" LABEL. Four characters of the word in every chip pushes the names — the thing being
 * scanned for — out of the first glance, and these wrap several to a row. Colour alone would fail a
 * colourblind reader and fail in a pasted screenshot, so the icon differs AND the qualifier states
 * it in words; nobody depends on hue. `warning` is the already-validated `--confidence-medium`
 * token, so no new colour enters the app.
 *
 * The qualifier is the UNIT of the number, not a mode chip: `surname 94%` says what was measured.
 * Language is deliberately absent from it — a Thai full-name match and an English one are the same
 * claim — and appears only in the tooltip, where there is room for the sentence it needs.
 *
 * Who IMPORTED the roster stays in the tooltip too. It and the owner were one fact until an owner
 * became per-friend-row, and this chip showed the wrong one of the two for as long as an external
 * workflow was filling `upload_name` with the importer: it named the person who pressed import and
 * linked to a roster page they had no friends on. The importer only matters when the roster looks
 * wrong, which is exactly the moment somebody hovers.
 *
 * The score is dropped, not dashed, when no run recorded one, and the qualifier goes with it. A
 * chip is a claim, and "Alex · —" makes a missing number look like a fact about the connection
 * rather than about the matcher.
 */
export function KnownByBadge({ uploader }: { uploader: ConnectedUploader }) {
  const score = formatSimilarity(uploader.similarity);
  // Graded on the client from `mode` rather than read off a server-sent label, so the grading has
  // exactly one definition (the contract's) and the two sides cannot drift into disagreeing.
  const confirmed = matchStrength(uploader.mode) === "confirmed";
  const qualifier = scoreQualifier(uploader.mode);
  const Icon = confirmed ? UserCheck : UserSearch;

  /**
   * The friend's other spelling — tooltip only, and only when it adds something.
   *
   * Suppressed when it equals the scored name, which is the common case on a one-language roster:
   * "Also on file as pornsak nakornthap" under a chip already reading `pornsak nakornthap` is noise
   * dressed as a disclosure. Same rule `ConnectionCard` applies to the same pair of fields.
   */
  const altSpelling =
    uploader.friendAlt && uploader.friendAlt !== uploader.friend ? uploader.friendAlt : null;

  /**
   * The sentence, composed here rather than inside `matchReason`.
   *
   * `matchReason` states what the run compared and how far to trust it — one wording, shared with
   * the company page's cards. These two clauses are about THIS chip's rendering (a spelling it
   * chose not to show, a name it had none of), so they are appended rather than pushed into the
   * contract, where they would have to be optional on every caller that does show them.
   */
  const reason = [
    matchReason(uploader.mode, score, {
      corroborated: uploader.corroborated,
      // Dropped when it says nothing the name already says. "win · Imported by win" is a sentence
      // that spends a reader's attention to tell them nothing, and the whole reason this field
      // exists is the case where the two names differ.
      importedBy: sameName(uploader.uploadedBy, uploader.name) ? null : uploader.uploadedBy,
    }),
    altSpelling && `${uploader.name}'s friend is also on file as ${altSpelling}; this spelling was not the one scored.`,
    // Said outright, because the chip's shape does not say it: a chip with no friend name looks
    // exactly like the old chip, and silence there reads as "we didn't bother" rather than as a gap
    // in what the run recorded about its own side.
    !uploader.friend && "This run recorded no name for the friend it matched.",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    // `max-w-full` against the badge's own `whitespace-nowrap`: two names in one chip can outrun a
    // narrow column, and a chip that sets the row wider than its card makes the whole result list
    // scroll sideways. The friend truncates (the tooltip still has it whole); the owner never does,
    // because it is the name being scanned for and half of it is not a name.
    <Badge
      variant={confirmed ? "success" : "warning"}
      title={reason}
      className="max-w-full cursor-pointer"
    >
      <Icon className="h-3 w-3" />
      {uploader.name}
      {uploader.friend && (
        <span className="flex min-w-0 items-baseline gap-1 opacity-75">
          <span aria-hidden>›</span>
          {/* Tagged `th` when the recorded string is Thai — a chip pools runs of both languages, so
              the browser cannot infer it from an ancestor the way a single-language block would. */}
          <span lang={hasThai(uploader.friend) ? "th" : undefined} className="truncate">
            {uploader.friend}
          </span>
        </span>
      )}
      {score && (
        // Divided off rather than merely spaced: the pairing and the score are different kinds of
        // fact (who knows whom, how the matcher scored them) and run together otherwise. A middle
        // dot rather than a rule — an alpha modifier on `currentColor` needs Tailwind v4, and a
        // full-strength border reads as a second edge inside the badge.
        <span className="shrink-0 tabular-nums opacity-75">
          {/* The unit is never dropped, on any mode — `full name 94%` as much as `surname 94%`.
              These chips pool runs of every mode into one row, and an unlabelled percent beside a
              labelled one reads as a formatting slip rather than as "this is the whole-name case",
              which is the strongest claim on the row and the one that most needs saying. */}
          · {qualifier} {score}
        </span>
      )}
    </Badge>
  );
}
