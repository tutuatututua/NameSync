"use client";

import * as React from "react";
import { Building2, Users } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader, SectionHeader } from "@/components/page-header";
import { UploadPanel } from "@/components/upload/UploadPanel";
import { ImportReview, type ImportSource } from "@/components/upload/ImportReview";
import { ImportsTable } from "@/components/uploads/ImportsTable";
import { UPLOAD_ACCEPT } from "@/lib/files";

/**
 * Uploads — put a file in, check what it holds, commit it, and see everything already in.
 *
 * ── THE HISTORY SPENT ONE DAY ON THE NETWORK PAGE, AND CAME BACK ──
 *
 * On 2026-08-06 the table moved to Network → Imports, on the argument that the three compare
 * scopes (company, owner, file) should each be a tab of the workspace where runs are started. The
 * symmetry was real; organising the screens around it was the mistake. It sorted pages by what the
 * server does with a row (`filter_by`) rather than by what somebody came here to do.
 *
 * What they came here to do, most of the time, is check whether a file is already in — and that is
 * asked with the file in hand, on the page with the drop zones. Sending the answer one page away
 * left this screen unable to say anything about what it already held, which is the one question it
 * is standing in the best position to answer.
 *
 * So the lifecycle is one page again: drop, review, commit, look back. The precheck's "you already
 * have these, from <import>" now points down this page instead of off it. Network keeps the two
 * scopes that are about the network and gains Results — see `ResultsTab`.
 */

export default function UploadsPage() {
  return (
    <div className="space-y-10">
      <PageHeader
        title="Uploads"
        description="Import company data or a friends list, and see every import already on file."
      />

      <ImportSection />

      {/*
        `id` because the duplicate precheck links here by anchor: "you already have these rows,
        from <import>" is only useful if the named import is somewhere you can go and look, and
        that somewhere is now a section of the page the reader is already on rather than a
        different page. See `PrecheckNote` in ImportReview.
      */}
      <section id="past-imports" className="scroll-mt-6 space-y-4">
        <SectionHeader
          title="Past imports"
          description="Every file on file — what it held, what became of it, and the runs it has been through."
        />
        <ImportsTable />
      </section>
    </div>
  );
}

/**
 * Two drop targets; once a file lands, the whole section becomes that file's review. The
 * review needs the full width — a column map and eight sample rows do not fit in half of
 * one — and there's no reason to keep the other drop zone on screen while you're deciding
 * about this one.
 */
function ImportSection() {
  const [picked, setPicked] = React.useState<{ source: ImportSource; file: File } | null>(null);

  if (picked) {
    return (
      <Card>
        <CardContent className="p-5">
          <ImportReview
            source={picked.source}
            file={picked.file}
            onCancel={() => setPicked(null)}
            onComplete={() => setPicked(null)}
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid gap-3 md:grid-cols-2">
      <DropCard
        source="company"
        icon={Building2}
        title="Company data"
        subtitle="A company export — Excel, CSV or JSON"
        accept={UPLOAD_ACCEPT}
        onFile={(file) => setPicked({ source: "company", file })}
      />
      {/* "Friends", not "Facebook": the social side takes LinkedIn exports and typed-up business
          cards too. The `facebook` source value, the `facebookFile` form field and the `friend`
          table keep their names — they are wire and schema identifiers with other systems on the
          far end, and renaming them would buy a tidier grep for the cost of a migration. */}
      <DropCard
        source="facebook"
        icon={Users}
        title="Friends"
        subtitle="A friends export — Excel, CSV or JSON"
        accept={UPLOAD_ACCEPT}
        onFile={(file) => setPicked({ source: "facebook", file })}
      />
    </div>
  );
}

function DropCard({
  icon: Icon,
  title,
  subtitle,
  accept,
  onFile,
}: {
  source: ImportSource;
  icon: typeof Building2;
  title: string;
  subtitle: string;
  accept: readonly string[];
  onFile: (file: File) => void;
}) {
  return (
    <Card>
      <CardContent className="space-y-4 p-5">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border bg-muted text-muted-foreground">
            <Icon className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <p className="font-medium">{title}</p>
            <p className="text-sm text-muted-foreground">{subtitle}</p>
          </div>
        </div>
        <UploadPanel
          accept={accept}
          file={null}
          onChange={(f) => f && onFile(f)}
          title="Drop a file"
          hint="or browse"
          className="min-h-[11rem]"
        />
      </CardContent>
    </Card>
  );
}
