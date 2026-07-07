"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { Building2, Users, GitCompareArrows, Sparkles, Loader2, RotateCcw, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { LoadingButton } from "@/components/loading-button";
import { Progress } from "@/components/ui/progress";
import { UploadPanel } from "@/components/upload/UploadPanel";
import { ResultsView } from "@/components/results/ResultsView";
import { useComparisonSocket } from "@/hooks/useComparisonSocket";
import { useRunComparison, useSendWebhook, useTriggerComparison, useSaveToHistory } from "@/hooks/mutations";
import { useResults, useCompanyCount, useFacebookCount, useDataStats } from "@/hooks/queries";
import { useQueryClient } from "@tanstack/react-query";
import { qk } from "@/hooks/queryKeys";

type Mode = "choose" | "added" | "running" | "done";

type SyncSummary = {
  source: "company" | "facebook";
  added: number;
  duplicates: number;
  uploadUser: string;
  sessionId: string;
  date: string;
};

function ComparePageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const preset = searchParams.get("add"); // "company" | "facebook" | null
  const autoRun = searchParams.get("run"); // "both" => auto-start Compare Both

  const [mode, setMode] = React.useState<Mode>("choose");
  const [name, setName] = React.useState("");
  const [sessionId, setSessionId] = React.useState<string | null>(null);
  const [progress, setProgress] = React.useState(0);
  const [summary, setSummary] = React.useState<SyncSummary | null>(null);

  const [companyFile, setCompanyFile] = React.useState<File | null>(null);
  const [facebookFile, setFacebookFile] = React.useState<File | null>(null);
  const [companyUploader, setCompanyUploader] = React.useState("");
  const [facebookUploader, setFacebookUploader] = React.useState("");
  const autoRan = React.useRef(false);

  const companyCount = useCompanyCount();
  const facebookCount = useFacebookCount();
  const stats = useDataStats();
  const qc = useQueryClient();

  const runMut = useRunComparison();
  const sendMut = useSendWebhook();
  const triggerMut = useTriggerComparison();
  const saveMut = useSaveToHistory();
  const results = useResults(mode === "done" && sessionId ? sessionId : "");

  useComparisonSocket(mode === "running" ? sessionId : null, {
    onMessage: (m) => {
      if (m.type === "batch_received" && typeof m.progress === "number") setProgress(m.progress);
    },
    onComplete: () => {
      setProgress(100);
      setMode("done");
      // The comparison just flipped every loaded row to "old" server-side; refresh
      // the breakdown so a later "Run another" shows accurate old/new counts.
      qc.invalidateQueries({ queryKey: qk.dataStats() });
    },
    onFailed: (m) => toast.error(("message" in m && m.message) || "Comparison failed"),
  });

  const busy = runMut.isPending || sendMut.isPending;

  // Compare Now: merge nothing new, then trigger the comparison over the full tables.
  async function run(form: FormData, label: string) {
    try {
      form.set("name", label);
      const data = await runMut.mutateAsync(form);
      setSessionId(data.sessionId);
      setName(label);
      await sendMut.mutateAsync(data.sessionId); // push any new rows to the workflow first
      setProgress(0);
      setMode("running");
      triggerMut.mutate(data.sessionId); // best-effort; results arrive via the callback
    } catch {
      /* mutations surface errors as toasts */
    }
  }

  const today = new Date().toLocaleDateString();

  // Sync = add this one table's data: merge + push to the workflow, then show a
  // summary. It does NOT run a comparison — that's the Compare Now button's job.
  async function sync(source: "company" | "facebook", file: File, uploader: string) {
    const form = new FormData();
    form.append(source === "company" ? "companyFile" : "facebookFile", file);
    form.append("uploadPersonName", uploader.trim());
    form.set("name", `${source === "company" ? "Company" : "Facebook"} update · ${today}`);
    try {
      const data = await runMut.mutateAsync(form);
      await sendMut.mutateAsync(data.sessionId); // push new rows to the workflow before summarizing
      setSummary({
        source,
        added: source === "company" ? data.companyAdded : data.facebookAdded,
        duplicates: source === "company" ? data.companyDuplicates : data.facebookDuplicates,
        uploadUser: uploader.trim(),
        sessionId: data.sessionId,
        date: today,
      });
      setMode("added");
    } catch {
      /* mutations surface errors as toasts */
    }
  }

  function addCompany() {
    if (!companyFile || !companyUploader.trim()) return;
    void sync("company", companyFile, companyUploader);
  }
  function addFacebook() {
    if (!facebookFile || !facebookUploader.trim()) return;
    void sync("facebook", facebookFile, facebookUploader);
  }
  function compareBoth() {
    void run(new FormData(), `Full comparison · ${today}`);
  }

  function reset() {
    setMode("choose");
    setSessionId(null);
    setProgress(0);
    setCompanyFile(null);
    setFacebookFile(null);
    setSummary(null);
  }

  const canCompareBoth = (companyCount.data ?? 0) > 0 && (facebookCount.data ?? 0) > 0;

  // Auto-start "Compare Both" once when arriving via /compare?run=both and both
  // tables have data (runs a single time; no-op when there's nothing to compare).
  React.useEffect(() => {
    if (autoRun === "both" && !autoRan.current && mode === "choose" && canCompareBoth) {
      autoRan.current = true;
      compareBoth();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRun, canCompareBoth, mode]);

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-1 flex items-center gap-2">
        <Sparkles className="h-5 w-5 text-primary" />
        <h1 className="text-2xl font-bold">Run a comparison</h1>
      </div>
      <p className="mb-6 text-muted-foreground">
        Add data to either table (it merges on top of what&apos;s there and compares against the
        whole other table), or compare both tables as they stand.
      </p>

      <AnimatePresence mode="wait" initial={false}>
        {mode === "choose" && (
          <motion.div
            key="choose"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            transition={{ duration: 0.2 }}
            className="grid gap-4 md:grid-cols-3"
          >
            {/* Add company */}
            <Card className={preset === "company" ? "ring-2 ring-primary" : undefined}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Building2 className="h-4 w-4 text-primary" /> Add Company Data
                </CardTitle>
                <CardDescription>Merge a CSV into the company table, then compare vs all Facebook.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <UploadPanel accept={[".csv"]} file={companyFile} onChange={setCompanyFile} title="Drop CSV" hint="or browse" />
                <div className="space-y-1.5">
                  <Label htmlFor="co-uploader" className="text-xs">
                    Upload user <span className="text-destructive">*</span>
                  </Label>
                  <Input id="co-uploader" required value={companyUploader} onChange={(e) => setCompanyUploader(e.target.value)} placeholder="e.g. Alex" />
                </div>
                <LoadingButton className="w-full" isLoading={busy} disabled={!companyFile || !companyUploader.trim()} onClick={addCompany}>
                  Sync
                </LoadingButton>
              </CardContent>
            </Card>

            {/* Add facebook */}
            <Card className={preset === "facebook" ? "ring-2 ring-primary" : undefined}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Users className="h-4 w-4 text-primary" /> Add Facebook Data
                </CardTitle>
                <CardDescription>Merge a JSON into the Facebook table, then compare vs all Company.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <UploadPanel accept={[".json"]} file={facebookFile} onChange={setFacebookFile} title="Drop JSON" hint="or browse" />
                <div className="space-y-1.5">
                  <Label htmlFor="fb-uploader" className="text-xs">
                    Upload user <span className="text-destructive">*</span>
                  </Label>
                  <Input id="fb-uploader" required value={facebookUploader} onChange={(e) => setFacebookUploader(e.target.value)} placeholder="e.g. Alex" />
                </div>
                <LoadingButton className="w-full" isLoading={busy} disabled={!facebookFile || !facebookUploader.trim()} onClick={addFacebook}>
                  Sync
                </LoadingButton>
              </CardContent>
            </Card>

            {/* Compare both */}
            <Card className="border-primary/30 bg-primary/5">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <GitCompareArrows className="h-4 w-4 text-primary" /> Compare Both Tables
                </CardTitle>
                <CardDescription>Re-run the full comparison across everything you&apos;ve added.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-2 rounded-lg border bg-card p-3 text-sm">
                  {[
                    { label: "Company", s: stats.data?.company },
                    { label: "Facebook", s: stats.data?.facebook },
                  ].map(({ label, s }) => {
                    const total = s?.total ?? 0;
                    const newRows = s?.newRows ?? 0;
                    const oldRows = Math.max(0, total - newRows);
                    return (
                      <div key={label}>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">{label} rows</span>
                          <span className="font-medium tabular-nums">{total.toLocaleString()}</span>
                        </div>
                        <div className="mt-0.5 flex justify-between text-xs text-muted-foreground">
                          <span className="tabular-nums">{oldRows.toLocaleString()} old</span>
                          <span className={`tabular-nums ${newRows > 0 ? "font-medium text-primary" : ""}`}>
                            {newRows > 0 ? "+" : ""}
                            {newRows.toLocaleString()} new
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <LoadingButton
                  variant="gradient"
                  className="w-full"
                  isLoading={busy}
                  disabled={!canCompareBoth}
                  onClick={compareBoth}
                >
                  <GitCompareArrows className="h-4 w-4" /> Compare Now
                </LoadingButton>
                {!canCompareBoth && (
                  <p className="text-center text-xs text-muted-foreground">Add data to both tables first.</p>
                )}
              </CardContent>
            </Card>
          </motion.div>
        )}

        {mode === "added" && summary && (
          <motion.div
            key="added"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            transition={{ duration: 0.2 }}
          >
            <Card className="mx-auto max-w-lg">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <CheckCircle2 className="h-5 w-5 text-primary" />
                  {summary.source === "company" ? "Company" : "Facebook"} data added
                </CardTitle>
                <CardDescription>
                  Merged into the {summary.source} table. Nothing is compared yet — use Compare Now when
                  you&apos;re ready.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg border bg-card p-3 text-sm">
                  <div>
                    <div className="text-xs text-muted-foreground">New rows added</div>
                    <div className="font-medium tabular-nums">{summary.added.toLocaleString()}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">Duplicates skipped</div>
                    <div className="font-medium tabular-nums">{summary.duplicates.toLocaleString()}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">Upload user</div>
                    <div className="font-medium">{summary.uploadUser}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">Date</div>
                    <div className="font-medium">{summary.date}</div>
                  </div>
                  <div className="col-span-2">
                    <div className="text-xs text-muted-foreground">Session</div>
                    <div className="truncate font-mono text-xs" title={summary.sessionId}>
                      {summary.sessionId}
                    </div>
                  </div>
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="outline" onClick={reset}>
                    <RotateCcw className="h-4 w-4" /> Add more data
                  </Button>
                  <LoadingButton
                    variant="gradient"
                    isLoading={busy}
                    disabled={!canCompareBoth}
                    onClick={compareBoth}
                  >
                    <GitCompareArrows className="h-4 w-4" /> Compare Now
                  </LoadingButton>
                </div>
                {!canCompareBoth && (
                  <p className="text-right text-xs text-muted-foreground">
                    Add data to the other table before you can compare.
                  </p>
                )}
              </CardContent>
            </Card>
          </motion.div>
        )}

        {mode === "running" && (
          <motion.div key="running" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <Card>
              <CardContent className="space-y-4 p-8">
                <div className="flex items-center justify-center">
                  <motion.div
                    animate={{ rotate: 360 }}
                    transition={{ repeat: Infinity, duration: 1.4, ease: "linear" }}
                    className="text-primary"
                  >
                    <Loader2 className="h-8 w-8" />
                  </motion.div>
                </div>
                <p className="text-center font-medium">Matching names…</p>
                <Progress value={progress} />
                <p className="text-center text-sm tabular-nums text-muted-foreground">{progress}% complete</p>
              </CardContent>
            </Card>
          </motion.div>
        )}

        {mode === "done" && (
          <motion.div key="done" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
            {results.isLoading ? (
              <p className="text-muted-foreground">Loading results…</p>
            ) : results.data ? (
              <>
                <ResultsView results={results.data.results} meanConfidence={results.data.meanConfidence} />
                <div className="mt-6 flex justify-end gap-2">
                  <Button variant="outline" onClick={reset}>
                    <RotateCcw className="h-4 w-4" /> Run another
                  </Button>
                  <LoadingButton
                    variant="gradient"
                    isLoading={saveMut.isPending}
                    onClick={async () => {
                      if (!sessionId || !results.data) return;
                      const saved = await saveMut.mutateAsync({
                        name,
                        comparison_id: sessionId,
                        row_count: results.data.rowCount,
                        mean_confidence: results.data.meanConfidence,
                        results: JSON.stringify(
                          results.data.results.map((r) => ({
                            fbName: r.fb_name,
                            companyName: r.person_name_en,
                            confidence: r.matching_score,
                          }))
                        ),
                      });
                      if (saved?.id) router.push(`/comparisons/${saved.id}?saved=1`);
                    }}
                  >
                    Save to History
                  </LoadingButton>
                </div>
              </>
            ) : (
              <p className="text-muted-foreground">No results found.</p>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function ComparePage() {
  return (
    <React.Suspense fallback={null}>
      <ComparePageInner />
    </React.Suspense>
  );
}
