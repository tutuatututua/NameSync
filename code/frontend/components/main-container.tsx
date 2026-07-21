"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

/**
 * Most pages are prose-and-cards and read better at a fixed column width, centred. The data-grid
 * pages are the exception — the Database console (a 10-column table next to a table list), Uploads
 * (a 9-column session table, plus an import review that lays a column map beside sample rows), and
 * a run's results. A hard cap cuts their right-hand columns off, so they get the whole window.
 *
 * The route list alone was not enough, and the Compare screen is why: it is `/`, so it is capped —
 * but once a run finishes it renders the *same* results block as `/comparisons/:id`, which is not.
 * The identical table therefore appeared at two different widths depending on which way you had
 * arrived at it, which reads as a rendering bug because it is one.
 *
 * The route cannot know that, because it is not a fact about the route: the Compare screen wants
 * the reading width while you are picking a company and the whole window once it is showing you
 * 1,300 rows. So width follows *content* — a component that needs the room says so, for as long as
 * it is mounted, and the cap is dropped underneath it.
 */
const FULL_WIDTH = ["/database", "/uploads", "/comparisons"];

const SetFullWidth = React.createContext<((full: boolean) => void) | null>(null);

/**
 * Drop the container's reading-width cap while this component is mounted.
 *
 * Call it unconditionally, as hooks require, and pass `active` to say whether you actually want
 * the room right now — a component that needs it only in one of its states (results yes, empty
 * state no) must not branch around the hook to express that.
 *
 * Outside a MainContainer this is a no-op rather than an error: a component's layout appetite is
 * not a reason it cannot be rendered somewhere else.
 */
export function useFullWidth(active = true): void {
  const set = React.useContext(SetFullWidth);

  React.useEffect(() => {
    if (!set || !active) return;
    set(true);
    // Released on unmount, so leaving the page — or a results block disappearing behind a reset —
    // puts the cap back rather than leaving the next screen stretched.
    return () => set(false);
  }, [set, active]);
}

export function MainContainer({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [contentWantsRoom, setContentWantsRoom] = React.useState(false);

  // A route that is full-width by its nature. Kept alongside the opt-in rather than replaced by it:
  // these pages are wide before any child has mounted to ask, and a first paint at the reading
  // width that then jumps open is worse than no animation at all.
  const routeIsWide = FULL_WIDTH.some((p) => pathname.startsWith(p));

  // Navigating away drops any opt-in the last page made. Without this, visiting a run and coming
  // back would leave Compare stretched, because the release only fires when the child unmounts and
  // the new page may mount before it does.
  React.useEffect(() => setContentWantsRoom(false), [pathname]);

  const full = routeIsWide || contentWantsRoom;

  return (
    <SetFullWidth.Provider value={setContentWantsRoom}>
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
    </SetFullWidth.Provider>
  );
}
