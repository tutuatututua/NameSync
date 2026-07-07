"use client";

import { motion } from "framer-motion";
import { getConfidenceTier, confidenceBar } from "@/lib/confidence";
import { cn } from "@/lib/utils";

/** Renders a 10-bin (0.0–1.0) histogram; bars are tinted by confidence tier and grow on mount. */
export function ConfidenceChart({ data }: { data: number[] }) {
  const max = Math.max(1, ...data);
  return (
    <div className="flex h-40 items-end gap-1.5" role="img" aria-label="Confidence distribution histogram">
      {data.map((count, i) => {
        const tier = getConfidenceTier((i + 0.5) / 10);
        const pct = (count / max) * 100;
        return (
          <div key={i} className="flex h-full flex-1 flex-col items-center gap-1">
            <div className="flex w-full flex-1 items-end">
              <motion.div
                initial={{ height: 0 }}
                animate={{ height: `${Math.max(pct, count > 0 ? 4 : 0)}%` }}
                transition={{ delay: i * 0.03, duration: 0.4, ease: "easeOut" }}
                className={cn("w-full rounded-t", confidenceBar[tier])}
                title={`${count} in ${(i / 10).toFixed(1)}–${((i + 1) / 10).toFixed(1)}`}
              />
            </div>
            <span className="text-[10px] tabular-nums text-muted-foreground">{(i / 10).toFixed(1)}</span>
          </div>
        );
      })}
    </div>
  );
}
