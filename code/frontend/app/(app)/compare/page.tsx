"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { Check, ArrowRight, ArrowLeft, Sparkles, Building2, Users, ClipboardCheck, Rocket, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { LoadingButton } from "@/components/loading-button";
import { Progress } from "@/components/ui/progress";
import { UploadPanel } from "@/components/upload/UploadPanel";
import { ResultsView } from "@/components/results/ResultsView";
import { cn } from "@/lib/utils";
import { useComparisonSocket } from "@/hooks/useComparisonSocket";
import { useUploadComparison, useSendWebhook, useTriggerComparison, useSaveToHistory } from "@/hooks/mutations";
import { useResults } from "@/hooks/queries";

const STEPS = [
  { key: "company", label: "Company", icon: Building2 },
  { key: "facebook", label: "Facebook", icon: Users },
  { key: "review", label: "Review", icon: ClipboardCheck },
  { key: "run", label: "Run", icon: Rocket },
  { key: "progress", label: "Progress", icon: Loader2 },
  { key: "results", label: "Results", icon: Sparkles },
] as const;

type StepIndex = 0 | 1 | 2 | 3 | 4 | 5;

function StepRail({ current }: { current: number }) {
  return (
    <ol className="mb-8 flex items-center gap-2">
      {STEPS.map((s, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <React.Fragment key={s.key}>
            <li className="flex items-center gap-2" aria-current={active ? "step" : undefined}>
              <span
                className={cn(
                  "flex h-8 w-8 items-center justify-center rounded-full border text-sm font-semibold transition-colors",
                  done && "border-primary bg-primary text-primary-foreground",
                  active && "border-primary bg-primary/10 text-primary",
                  !done && !active && "border-input text-muted-foreground"
                )}
              >
                {done ? <Check className="h-4 w-4" /> : i + 1}
              </span>
              <span className={cn("hidden text-sm font-medium sm:inline", active ? "text-foreground" : "text-muted-foreground")}>
                {s.label}
              </span>
            </li>
            {i < STEPS.length - 1 && <span className="h-px flex-1 bg-border" />}
          </React.Fragment>
        );
      })}
    </ol>
  );
}

const variants = {
  enter: { opacity: 0, x: 40 },
  center: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: -40 },
};

export default function ComparePage() {
  const router = useRouter();
  const [step, setStep] = React.useState<StepIndex>(0);
  const [companyFile, setCompanyFile] = React.useState<File | null>(null);
  const [facebookFile, setFacebookFile] = React.useState<File | null>(null);
  const [uploadPersonName, setUploadPersonName] = React.useState("");
  const [name, setName] = React.useState(`Comparison ${new Date().toLocaleDateString()}`);
  const [sessionId, setSessionId] = React.useState<string | null>(null);
  const [progress, setProgress] = React.useState(0);

  const uploadMut = useUploadComparison();
  const sendMut = useSendWebhook();
  const triggerMut = useTriggerComparison();
  const saveMut = useSaveToHistory();
  const results = useResults(step === 5 && sessionId ? sessionId : "");

  useComparisonSocket(step === 4 ? sessionId : null, {
    onMessage: (m) => {
      if (m.type === "batch_received" && typeof m.progress === "number") setProgress(m.progress);
    },
    onComplete: () => {
      setProgress(100);
      setStep(5);
    },
    onFailed: (m) => toast.error(("message" in m && m.message) || "Comparison failed"),
  });

  const go = (next: StepIndex) => setStep(next);

  const runComparison = async () => {
    try {
      const fd = new FormData();
      fd.append("name", name.trim() || "Comparison");
      fd.append("mode", "fresh");
      if (uploadPersonName.trim()) fd.append("uploadPersonName", uploadPersonName.trim());
      if (companyFile) fd.append("companyFile", companyFile);
      if (facebookFile) fd.append("facebookFile", facebookFile);

      const created = await uploadMut.mutateAsync(fd);
      setSessionId(created.sessionId);
      toast.success(`Saved ${created.companyRecordsCount + created.facebookRecordsCount} records`);

      await sendMut.mutateAsync(created.sessionId);
      setStep(4);
      // Trigger is best-effort: if the matcher isn't configured we still wait for
      // results to arrive at the callback (surfaced via the socket / polling).
      triggerMut.mutate(created.sessionId);
    } catch {
      /* errors already surfaced as toasts by the mutations */
    }
  };

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-2 flex items-center gap-2">
        <Sparkles className="h-5 w-5 text-primary" />
        <h1 className="font-display text-2xl font-bold">New Comparison</h1>
      </div>
      <p className="mb-6 text-muted-foreground">Upload both files, then run the confidence-scored name match.</p>

      <StepRail current={step} />

      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={step}
          variants={variants}
          initial="enter"
          animate="center"
          exit="exit"
          transition={{ duration: 0.25, ease: "easeOut" }}
        >
          {step === 0 && (
            <StepShell title="Upload Company data" subtitle="A CSV with columns “Company Name” and “Thai Name”.">
              <UploadPanel accept={[".csv"]} file={companyFile} onChange={setCompanyFile} title="Drop your Company CSV here" hint="or click to browse" />
              <Nav onNext={() => go(1)} nextDisabled={!companyFile} />
            </StepShell>
          )}

          {step === 1 && (
            <StepShell title="Upload Facebook data" subtitle="Your Facebook friends export (friends_v2 JSON).">
              <UploadPanel accept={[".json"]} file={facebookFile} onChange={setFacebookFile} title="Drop your Facebook JSON here" hint="or click to browse" />
              <div className="mt-4 space-y-1.5">
                <Label htmlFor="uploader">Whose friends list is this? (optional)</Label>
                <Input id="uploader" value={uploadPersonName} onChange={(e) => setUploadPersonName(e.target.value)} placeholder="e.g. Alex" />
              </div>
              <Nav onBack={() => go(0)} onNext={() => go(2)} nextDisabled={!facebookFile} />
            </StepShell>
          )}

          {step === 2 && (
            <StepShell title="Review" subtitle="Name this comparison, then continue.">
              <div className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <SummaryCard icon={Building2} label="Company file" value={companyFile?.name ?? "—"} />
                  <SummaryCard icon={Users} label="Facebook file" value={facebookFile?.name ?? "—"} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="name">Comparison name</Label>
                  <Input id="name" value={name} onChange={(e) => setName(e.target.value)} />
                </div>
              </div>
              <Nav onBack={() => go(1)} onNext={() => go(3)} nextDisabled={!name.trim()} />
            </StepShell>
          )}

          {step === 3 && (
            <StepShell title="Ready to run" subtitle="We'll save your data and start the match.">
              <Card>
                <CardContent className="flex flex-col items-center gap-4 p-8 text-center">
                  <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-brand text-primary-foreground shadow-lg">
                    <Rocket className="h-6 w-6" />
                  </div>
                  <p className="text-muted-foreground">
                    Comparing <span className="font-medium text-foreground">{companyFile?.name}</span> against{" "}
                    <span className="font-medium text-foreground">{facebookFile?.name}</span>.
                  </p>
                  <LoadingButton
                    size="lg"
                    variant="gradient"
                    isLoading={uploadMut.isPending || sendMut.isPending}
                    onClick={runComparison}
                  >
                    <Sparkles className="h-4 w-4" /> Run Comparison
                  </LoadingButton>
                </CardContent>
              </Card>
              <Nav onBack={() => go(2)} />
            </StepShell>
          )}

          {step === 4 && (
            <StepShell title="Matching names…" subtitle="Live progress — this stays connected until it completes.">
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
                  <Progress value={progress} />
                  <p className="text-center text-sm tabular-nums text-muted-foreground">{progress}% complete</p>
                </CardContent>
              </Card>
            </StepShell>
          )}

          {step === 5 && (
            <StepShell title="Results" subtitle="Confidence-scored name matches.">
              {results.isLoading ? (
                <p className="text-muted-foreground">Loading results…</p>
              ) : results.data ? (
                <>
                  <ResultsView results={results.data.results} meanConfidence={results.data.meanConfidence} />
                  <div className="mt-6 flex justify-end">
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
            </StepShell>
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

function StepShell({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div>
      <h2 className="font-display text-xl font-semibold">{title}</h2>
      <p className="mb-5 text-sm text-muted-foreground">{subtitle}</p>
      {children}
    </div>
  );
}

function Nav({ onBack, onNext, nextDisabled }: { onBack?: () => void; onNext?: () => void; nextDisabled?: boolean }) {
  return (
    <div className="mt-6 flex items-center justify-between">
      {onBack ? (
        <Button variant="ghost" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" /> Back
        </Button>
      ) : (
        <span />
      )}
      {onNext && (
        <Button onClick={onNext} disabled={nextDisabled}>
          Next <ArrowRight className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
}

function SummaryCard({ icon: Icon, label, value }: { icon: typeof Building2; label: string; value: string }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border bg-card p-4">
      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <Icon className="h-5 w-5" />
      </div>
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="truncate font-medium">{value}</p>
      </div>
    </div>
  );
}
