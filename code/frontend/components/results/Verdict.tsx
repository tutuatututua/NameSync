"use client";

import { Building2, SearchX, Sparkles, UserCheck, Users } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { MATCH_THRESHOLD } from "@/lib/confidence";
import type { MergeFacts } from "@/lib/match";
import { cn } from "@/lib/utils";

/**
 * The answer to the question the user actually asked.
 *
 * A run scores every friend against the company and keeps each one's closest contact, so its
 * output is the friend list — in a typical run 90%+ of the rows are strangers at single-digit
 * scores. This page used to open on statistics computed over that population: "Mean similarity
 * 16%", "Lowest 0%". Both are true, both are about the strangers, and neither is the finding.
 * A run that turned up twelve near-certain colleagues and one that turned up nothing look
 * nearly identical through them.
 *
 * So the page opens on the finding instead: how many friends matched, out of how many scored.
 * Everything under it — the merge picture, the table — is evidence for this sentence.
 */
export function Verdict({ facts, company }: { facts: MergeFacts; company: string | null }) {
  const { matches, strong, friends, contacts, matchedUploaders } = facts;
  const companyLabel = company ?? "the company";
  const none = matches === 0;

  return (
    <Card className={cn(!none && "border-confidence-high/30")}>
      <CardContent className="flex flex-col gap-6 p-5 sm:p-6 lg:flex-row lg:items-center lg:justify-between lg:gap-8">
        <div className="flex items-start gap-4">
          <span
            className={cn(
              "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl shadow-xs",
              none
                ? "border bg-muted text-muted-foreground"
                : "bg-gradient-brand text-white"
            )}
          >
            {none ? (
              <SearchX className="h-5 w-5" aria-hidden />
            ) : (
              <Sparkles className="h-5 w-5" aria-hidden />
            )}
          </span>

          <div className="min-w-0 space-y-1">
            {/* The headline is a sentence, not a metric. A number on its own ("13") still
                makes the reader do the work of deciding what it counted. */}
            <h2 className="font-display text-xl font-semibold leading-tight tracking-tight sm:text-2xl">
              {none ? (
                <>No friend matches anyone at {companyLabel}</>
              ) : (
                <>
                  <span className="text-primary">
                    {matches.toLocaleString()} {matches === 1 ? "friend" : "friends"}
                  </span>{" "}
                  {matches === 1 ? "matches" : "match"} someone at {companyLabel}
                </>
              )}
            </h2>
            <p className="text-sm text-muted-foreground">
              out of {friends.toLocaleString()} scored ·{" "}
              {/* Naming the bar is what keeps the headline honest: it is a threshold, not a
                  fact of nature, and a reader who disagrees with it can go read the rest. */}
              <span className="whitespace-nowrap">
                a match is {Math.round(MATCH_THRESHOLD * 100)}% similarity or better
              </span>
            </p>
          </div>
        </div>

        {none ? (
          <p className="max-w-sm shrink-0 text-sm text-muted-foreground lg:text-right">
            Every friend still has a closest contact — they are all just too distant to call the
            same person. Switch the table to{" "}
            <span className="font-medium text-foreground">All scored</span> to read them.
          </p>
        ) : (
          <dl className="grid shrink-0 grid-cols-3 gap-x-6 gap-y-1 sm:gap-x-8">
            <Fact
              icon={UserCheck}
              value={strong}
              label={strong === 1 ? "near-certain" : "near-certain"}
              hint="≥80%"
              emphasis
            />
            <Fact
              icon={Building2}
              value={contacts}
              label={contacts === 1 ? "contact" : "contacts"}
              hint="at the company"
            />
            <Fact
              icon={Users}
              value={matchedUploaders}
              label={matchedUploaders === 1 ? "uploader" : "uploaders"}
              hint="with a connection"
            />
          </dl>
        )}
      </CardContent>
    </Card>
  );
}

/** One supporting number. Tabular figures — these sit in a row and have to line up. */
function Fact({
  icon: Icon,
  value,
  label,
  hint,
  emphasis,
}: {
  icon: LucideIcon;
  value: number;
  label: string;
  hint: string;
  emphasis?: boolean;
}) {
  return (
    <div className="space-y-0.5">
      <dd
        className={cn(
          "font-display text-2xl font-semibold leading-none tabular-nums tracking-tight",
          emphasis ? "text-confidence-high" : "text-foreground"
        )}
      >
        {value.toLocaleString()}
      </dd>
      <dt className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
        <Icon className="h-3 w-3 shrink-0" aria-hidden />
        {label}
      </dt>
      <p className="text-2xs text-muted-foreground/70">{hint}</p>
    </div>
  );
}
