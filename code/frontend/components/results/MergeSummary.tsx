import type { LucideIcon } from "lucide-react";
import { ArrowLeft, ArrowRight, Building2, GitMerge, Users } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import type { MergeFacts } from "@/lib/match";
import { cn } from "@/lib/utils";

/**
 * What actually went into the run.
 *
 * A comparison is a join, and a joined row is precisely the view in which you can no longer
 * tell which half came from where — the table below shows a Facebook name and a company name
 * as adjacent columns, as if they had always belonged to the same record. They didn't. This
 * says so once, up front, and names the exact fields each side handed over.
 *
 * It used to close with a paragraph explaining that the table is a list of friends rather
 * than a list of matches — a caption compensating for a table that opened on 299 strangers.
 * The table now opens on the matches and says so in its own header, so the paragraph was
 * explaining a problem that no longer exists.
 *
 * The gradient is spent on the merge node on purpose. It's the app's one brand flourish, and
 * this is the single picture in the product where indigo→cyan means something literal: two
 * sources, one result.
 */

const TONE = {
  facebook: "border-l-2 border-l-brand-2",
  company: "border-l-2 border-l-brand",
} as const;

export function MergeSummary({
  facts,
  company,
}: {
  facts: MergeFacts;
  company: string | null;
}) {
  const { friends, uploaders, contacts } = facts;
  const companyLabel = company ?? "the company";

  return (
    <Card>
      <CardContent className="p-5">
        <div className="grid items-stretch gap-3 md:grid-cols-[1fr_auto_1fr]">
          {/* Company on the left, Facebook on the right — the same order as the table below,
              which is the thing this picture is a legend for. */}
          <SourcePanel
            tone={TONE.company}
            icon={Building2}
            eyebrow="Company"
            title={companyLabel}
            table="company_contact"
            stats={[
              { value: contacts, label: contacts === 1 ? "contact matched" : "contacts matched" },
            ]}
            fields={["person_name_en", "person_name_th"]}
          />

          <MergeNode />

          <SourcePanel
            tone={TONE.facebook}
            icon={Users}
            eyebrow="Facebook"
            title="Friends you imported"
            table="friend"
            stats={[
              { value: friends, label: friends === 1 ? "friend scored" : "friends scored" },
              { value: uploaders, label: uploaders === 1 ? "uploader" : "uploaders" },
            ]}
            fields={["friend_name", "uploaded_by"]}
          />
        </div>
      </CardContent>
    </Card>
  );
}

function SourcePanel({
  tone,
  icon: Icon,
  eyebrow,
  title,
  table,
  stats,
  fields,
}: {
  tone: string;
  icon: LucideIcon;
  eyebrow: string;
  title: string;
  table: string;
  stats: { value: number; label: string }[];
  fields: string[];
}) {
  return (
    <div className={cn("rounded-lg border bg-muted/30 p-4", tone)}>
      <div className="flex items-center gap-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border bg-card text-foreground shadow-xs">
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
            {eyebrow}
          </p>
          <p className="truncate font-medium leading-tight">{title}</p>
        </div>
        <code className="shrink-0 self-start rounded border bg-card px-1.5 py-0.5 font-mono text-2xs text-muted-foreground">
          {table}
        </code>
      </div>

      <div className="mt-3 space-y-0.5">
        {stats.map((s) => (
          <p key={s.label} className="text-sm text-muted-foreground">
            <span className="font-medium tabular-nums text-foreground">
              {s.value.toLocaleString()}
            </span>{" "}
            {s.label}
          </p>
        ))}
      </div>

      {/* The literal answer to "what data merged": these columns, and no others. */}
      <div className="mt-3 flex flex-wrap gap-1">
        {fields.map((f) => (
          <code
            key={f}
            className="rounded border bg-card px-1.5 py-0.5 font-mono text-2xs text-muted-foreground"
          >
            {f}
          </code>
        ))}
      </div>
    </div>
  );
}

/** Two arrows pointing inward, because that is what a merge is. */
function MergeNode() {
  return (
    <div className="flex items-center justify-center gap-1.5">
      <ArrowRight className="hidden h-4 w-4 shrink-0 text-muted-foreground md:block" aria-hidden />
      <span className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-brand text-white shadow-sm">
        <GitMerge className="h-[18px] w-[18px]" aria-hidden />
      </span>
      <ArrowLeft className="hidden h-4 w-4 shrink-0 text-muted-foreground md:block" aria-hidden />
    </div>
  );
}
