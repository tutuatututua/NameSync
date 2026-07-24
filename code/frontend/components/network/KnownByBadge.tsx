import { UserCheck } from "lucide-react";
import type { ConnectedUploader } from "@extensions/contract";
import { Badge } from "@/components/ui/badge";
import { formatSimilarity } from "@/lib/format";

/**
 * "Alex knows this person — 83%."
 *
 * One chip, two facts, and the second is why this is a component rather than the two lines of JSX
 * it replaced. The chip used to be a name alone, which made every connection read equally certain:
 * a friend whose name matched a contact exactly and one whose name merely resembled theirs both
 * came out as the same green badge. The percent is the difference between an introduction you can
 * ask for and one worth checking first.
 *
 * Shared by Search and the company page because they show the same row through two front doors
 * (both read `GET /network/search`) — a chip that says one thing in the search results and another
 * on the company page would be two answers to one question.
 *
 * The score is dropped, not dashed, when no run recorded one. A chip is a claim, and "Alex · —"
 * makes a missing number look like a fact about the connection rather than about the matcher.
 */
export function KnownByBadge({ uploader }: { uploader: ConnectedUploader }) {
  const score = formatSimilarity(uploader.similarity);
  return (
    <Badge
      variant="success"
      title={score ? `Knows this person — ${score} name match` : "Knows this person"}
      className="cursor-pointer"
    >
      <UserCheck className="h-3 w-3" />
      {uploader.name}
      {score && (
        // Divided off rather than merely spaced: the name and the score are different kinds of fact
        // (who uploaded the friend, how the matcher scored them) and run together otherwise. A
        // middle dot rather than a rule — an alpha modifier on `currentColor` needs Tailwind v4,
        // and a full-strength border reads as a second edge inside the badge.
        <span className="tabular-nums opacity-75">· {score}</span>
      )}
    </Badge>
  );
}
