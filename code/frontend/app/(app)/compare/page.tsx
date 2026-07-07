"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { GitCompareArrows, Sparkles, Loader2, RotateCcw, Building2 } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { LoadingButton } from "@/components/loading-button";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ResultsView } from "@/components/results/ResultsView";
import { useComparisonSocket } from "@/hooks/useComparisonSocket";
import { useCompareByCompany, useSaveToHistory } from "@/hooks/mutations";
import { useResults, useCompanies } from "@/hooks/queries";
import { useQueryClient } from "@tanstack/react-query";
import { qk } from "@/hooks/queryKeys";

type Mode = "choose" | "running" | "done";

export default function ComparePage() {
  const router = useRouter();
  const [mode, setMode] = React.useState<Mode>("choose");
  const [company, setCompany] = React.useState("");
  const [sessionId, setSessionId] = React.useState<string | null>(null);
  const [progress, setProgress] = React.useState(0);

  const companies = useCompanies();
  const compareMut = useCompareByCompany();
  const saveMut = useSaveToHistory();
  const results = useResults(mode === "done" && sessionId ? sessionId : "");
  const qc = useQueryClient();

  useComparisonSocket(mode === "running" ? sessionId : null, {
    onMessage: (m) => {
      if (m.type === "batch_received" && typeof m.progress === "number") setProgress(m.progress);
    },
    onComplete: () => {
      setProgress(100);
      setMode("done");
      qc.invalidateQueries({ queryKey: qk.results(sessionId ?? "") });
    },
    onFailed: (m) => {
      toast.error(("message" in m && m.message) || "Comparison failed");
      setMode("choose");
    },
  });

  async function compare() {
    if (!company) return;
    try {
      const data = await compareMut.mutateAsync(company);
      setSessionId(data.sessionId);
      setProgress(0);
      setMode("running");
    } catch {
      /* mutations surface errors as toasts */
    }
  }

  function reset() {
    setMode("choose");
    setSessionId(null);
    setProgress(0);
  }

  const hasCompanies = (companies.data?.length ?? 0) > 0;

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-1 flex items-center gap-2">
        <Sparkles className="h-5 w-5 text-primary" />
        <h1 className="text-2xl font-bold">Compare</h1>
      </div>
      <p className="mb-6 text-muted-foreground">
        Pick a company to find out whether any uploader has a potential connection with people who
        belong to it. Import data first from the Company and Facebook Data pages.
      </p>

      <AnimatePresence mode="wait" initial={false}>
        {mode === "choose" && (
          <motion.div
            key="choose"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            transition={{ duration: 0.2 }}
          >
            <Card className="mx-auto max-w-lg">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Building2 className="h-4 w-4 text-primary" /> Select a company
                </CardTitle>
                <CardDescription>
                  Choose from the companies already in the database.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="company" className="text-xs">
                    Company <span className="text-destructive">*</span>
                  </Label>
                  <Select value={company} onValueChange={setCompany} disabled={!hasCompanies}>
                    <SelectTrigger id="company">
                      <SelectValue placeholder={hasCompanies ? "Select a company…" : "No companies yet"} />
                    </SelectTrigger>
                    <SelectContent>
                      {(companies.data ?? []).map((c) => (
                        <SelectItem key={c} value={c}>
                          {c}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <LoadingButton
                  variant="gradient"
                  className="w-full"
                  isLoading={compareMut.isPending}
                  disabled={!company}
                  onClick={compare}
                >
                  <GitCompareArrows className="h-4 w-4" /> Compare
                </LoadingButton>
                {!hasCompanies && !companies.isLoading && (
                  <p className="text-center text-xs text-muted-foreground">
                    Import company data first — the list is built from the companies in the database.
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
                <p className="text-center font-medium">Matching against {company}…</p>
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
                <ResultsView
                  results={results.data.results}
                  meanConfidence={results.data.meanConfidence}
                  selectedCompany={results.data.selectedCompany}
                />
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
                        name: `Compare: ${results.data.selectedCompany ?? company}`,
                        comparison_id: sessionId,
                        row_count: results.data.rowCount,
                        mean_confidence: results.data.meanConfidence,
                        results: JSON.stringify(
                          results.data.results.map((r) => ({
                            fbName: r.fb_name,
                            uploadName: r.upload_name,
                            companyName: results.data!.selectedCompany,
                            engName: r.person_name_en,
                            thaiName: r.person_name_th,
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
