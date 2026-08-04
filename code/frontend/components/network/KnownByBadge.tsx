import { UserCheck, UserSearch } from "lucide-react";
import {
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
 * "Alex knows this person — 83%." — or, when that is more than the evidence supports, "Alex has a
 * friend with the same surname."
 *
 * One chip, three facts. It began as a name alone, which made every connection read equally
 * certain. The percent was added next, on the argument that it was "the difference between an
 * introduction you can ask for and one worth checking first" — and that argument was half right.
 * The percent distinguishes a close string from a distant one, but it says nothing about WHAT was
 * compared, and once runs stopped all asking the same question that became the bigger gap:
 * `Alex · 94%` renders identically whether that 94% is two whole names or two surnames. A
 * surname-only match presented as "Alex knows this person" is one step from an introduction
 * requested in a colleague's name on the strength of a shared "smith".
 *
 * So the chip now grades itself, and the tier rides on three redundant channels at no extra width:
 *
 *   confirmed   [✓ Alex · 94%]           green, UserCheck
 *   lead        [⌕ Alex · surname 92%]   amber, UserSearch
 *   no score    [⌕ Alex]                 amber, UserSearch
 *
 * NO "Lead" LABEL. Four characters of the word in every chip pushes the name — the thing being
 * scanned for — out of the first glance, and these wrap several to a row. Colour alone would fail a
 * colourblind reader and fail in a pasted screenshot, so the icon differs AND the qualifier states
 * it in words; nobody depends on hue. `warning` is the already-validated `--confidence-medium`
 * token, so no new colour enters the app.
 *
 * The qualifier is the UNIT of the number, not a mode chip: `surname 94%` says what was measured.
 * Language is deliberately absent from it — a Thai full-name match and an English one are the same
 * claim — and appears only in the tooltip, where there is room for the sentence it needs.
 *
 * THE NAME IS THE RELATIONSHIP OWNER, and who imported their roster is in the tooltip beside the
 * language. Those were one fact until an owner became per-friend-row, and this chip showed the
 * wrong one of the two for as long as an external workflow was filling `upload_name` with the
 * importer: it named the person who pressed import and linked to a roster page they had no friends
 * on. The owner is what the reader acts on — it is the answer to "who do I ask" — so it holds the
 * face of the chip alone. The importer only matters when the roster looks wrong, which is exactly
 * the moment somebody hovers.
 *
 * Shared by Search and the company page because they show the same row through two front doors
 * (both read `GET /network/search`) — a chip that said one thing in the search results and another
 * on the company page would be two answers to one question.
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

  return (
    <Badge
      variant={confirmed ? "success" : "warning"}
      title={matchReason(uploader.mode, score, {
        corroborated: uploader.corroborated,
        // Dropped when it says nothing the name already says. "win · Imported by win" is a sentence
        // that spends a reader's attention to tell them nothing, and the whole reason this field
        // exists is the case where the two names differ.
        importedBy: sameName(uploader.uploadedBy, uploader.name) ? null : uploader.uploadedBy,
      })}
      className="cursor-pointer"
    >
      <Icon className="h-3 w-3" />
      {uploader.name}
      {score && (
        // Divided off rather than merely spaced: the name and the score are different kinds of fact
        // (who uploaded the friend, how the matcher scored them) and run together otherwise. A
        // middle dot rather than a rule — an alpha modifier on `currentColor` needs Tailwind v4,
        // and a full-strength border reads as a second edge inside the badge.
        <span className="tabular-nums opacity-75">
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
