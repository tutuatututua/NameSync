"use client";

import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

/**
 * Most pages are prose-and-cards and read better at a fixed column width, centred.
 * The data-grid pages are the exception — the Database console (a 10-column table next to
 * a table list), Uploads (a 9-column session table, plus an import review that lays a column
 * map beside sample rows), and a run's results (a six-column table carrying two source
 * blocks and a score). A hard cap cuts their right-hand columns off, so they get the whole
 * window instead.
 *
 * `/comparisons/:id` was the one that hurt: it renders the widest table in the product inside
 * the narrow column, so Similarity — the column the page exists for — was the first thing
 * squeezed.
 */
const FULL_WIDTH = ["/database", "/uploads", "/comparisons"];

export function MainContainer({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const full = FULL_WIDTH.some((p) => pathname.startsWith(p));

  return (
    <main
      className={cn(
        "w-full flex-1 px-4 py-6 md:px-10 md:py-10",
        full ? "max-w-none" : "mx-auto max-w-5xl"
      )}
    >
      {/* Keyed on the route so each page arrives with the same short rise, rather than
          snapping in. It's the one transition that applies to everything. */}
      <div key={pathname} className="animate-fade-up">
        {children}
      </div>
    </main>
  );
}
