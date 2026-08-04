import Link from "next/link";
import { Import, UserRound } from "lucide-react";
import { sameName } from "@/components/network/KnownByBadge";
import { withThreshold } from "@/hooks/useThreshold";
import { cn } from "@/lib/utils";

/**
 * WHOSE RELATIONSHIP THIS IS, AND WHO FILED IT — the two-name provenance strip, in one place.
 *
 * These are two different facts about two possibly-different people (an assistant importing on a
 * salesperson's behalf is the case that split the columns), and every surface that shows a
 * connection has to answer both. They were answered twice, differently: the company page's
 * `ConnectionCard` gave them a labelled strip with icons and a link to the owner's roster, while a
 * run row spelled the owner out in accent text above and dropped `uploaded by Alex` into the grey
 * line with the timestamp and the extras — no icons, no link, and silently absent when null.
 *
 * Same two fields, two vocabularies (`Owner` vs `relationship owner`), and one of the two pages
 * teaching the reader that a missing importer means "no importer". The `RunRows` header even
 * documented its wording as matching "what `ConnectionCard` calls it", which it did not — the
 * intent to agree was recorded and nothing enforced it. This component is the enforcement.
 *
 * BOTH SLOTS, ALWAYS — as long as there is one fact to state. A line that appears only when owner
 * and importer differ teaches the reader nothing about what it means the rest of the time, and its
 * absence reads as "nobody imported this" rather than "the same person did". When neither is on
 * file there is no provenance to render and the strip disappears entirely, which is the one case
 * where saying nothing is the honest answer.
 */
export function Provenance({
  owner,
  uploadedBy,
  threshold,
  className,
}: {
  /** `friend.relationship_owner` — the person to ask for the introduction. */
  owner: string | null | undefined;
  /** `upload.uploaded_by` — the person who performed the import. */
  uploadedBy: string | null | undefined;
  /**
   * The workspace bar in effect where this strip is being read, hung on the owner's link.
   *
   * OMITTED on a surface that has no bar — a run row, which is read at its matcher's verdicts. Not
   * `null`: null is "show me the stored verdicts", and a run row has no business asserting that
   * about the roster page it links to. Left off, the link lands on whatever the workspace opens at.
   *
   * On the company page it is the bar the reader tuned, and dropping it here was a hole in the one
   * promise the control makes: the tiles above these cards, the "who can reach this company" links
   * beside them and the back link all carried it, so the owner's name was the single way out of a
   * tuned workspace that silently reverted to the matchers' verdicts. See `withThreshold`.
   */
  threshold?: number | null;
  className?: string;
}) {
  if (!owner && !uploadedBy) return null;

  // Folded by case, because every owner name in the product is grouped that way — see `sameName`.
  // Without it a chip announces an importer who is the owner under a different capitalisation.
  const selfImported = sameName(uploadedBy, owner);

  return (
    <div className={cn("flex flex-wrap items-center gap-x-4 gap-y-1 text-xs", className)}>
      <span className="flex items-center gap-1.5 text-muted-foreground">
        <UserRound className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>Owner</span>
        {owner ? (
          // The owner is the person you go and ask, so their name is the link — to their roster,
          // which `friend.relationship_owner` guarantees is not empty.
          <Link
            href={withThreshold(`/uploaders/${encodeURIComponent(owner)}`, threshold)}
            className="font-medium text-foreground underline-offset-2 hover:underline"
            title={`${owner} owns this relationship — the person to ask for the introduction.`}
          >
            {owner}
          </Link>
        ) : (
          // Never back-filled from the importer, for the same reason the importer is never
          // back-filled from the owner: they are different facts, and an external workflow filling
          // `upload_name` with the importer is the bug that made this distinction load-bearing.
          <span className="italic" title="No relationship owner is recorded for this row.">
            not recorded
          </span>
        )}
      </span>

      <span className="flex items-center gap-1.5 text-muted-foreground">
        <Import className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>Uploaded by</span>
        {uploadedBy ? (
          <span
            className={cn("font-medium", selfImported ? "text-muted-foreground" : "text-foreground")}
            title={
              selfImported
                ? `${uploadedBy} imported their own roster.`
                : `${uploadedBy} performed the import that brought this record in — ask them if the roster looks wrong.${
                    owner ? ` The relationship is ${owner}'s.` : ""
                  }`
            }
          >
            {uploadedBy}
            {selfImported && <span className="font-normal opacity-70"> (the owner)</span>}
          </span>
        ) : (
          <span className="italic" title="No import on file records who performed it.">
            not recorded
          </span>
        )}
      </span>
    </div>
  );
}
