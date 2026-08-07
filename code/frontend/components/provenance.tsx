"use client";

import Link from "next/link";
import { Import, UserRound } from "lucide-react";
import { sameName } from "@/components/network/KnownByBadge";
import { useCarriedThreshold, withThreshold } from "@/hooks/useThreshold";
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
 *
 * ── THE WORKSPACE BAR RIDES ON THE OWNER'S LINK, AND IS NOT A PROP (2026-08-07) ──
 *
 * It was one. The company page passed the bar it was tuned to and the run row passed nothing —
 * documented as deliberate, on the grounds that a run is read at its matcher's verdicts and has no
 * bar to assert. That reasoning was right about the RUN and wrong about the READER: a bar set on
 * Network, carried into a result, is still the bar that reader is working at, and dropping it here
 * meant clicking the relationship owner inside a result landed on that roster at the default. The
 * one promise the control makes — "the bar follows you into a company or a roster" — was broken by
 * the single link people follow to get to a roster.
 *
 * So the strip reads the bar off the URL it is being rendered on (`useCarriedThreshold`) instead of
 * being told. Nothing to forget at a call site, and no page that draws this can silently disagree
 * with the page beside it. A URL with no bar on it still carries nothing, which is exactly what a
 * run page linked to from outside the workspace should do.
 */
export function Provenance({
  owner,
  uploadedBy,
  className,
}: {
  /** `friend.relationship_owner` — the person to ask for the introduction. */
  owner: string | null | undefined;
  /** `upload.uploaded_by` — the person who performed the import. */
  uploadedBy: string | null | undefined;
  className?: string;
}) {
  // Hooks before the early return — `useCarriedThreshold` must run on every render, including the
  // ones where there is no provenance to draw.
  const threshold = useCarriedThreshold();

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
