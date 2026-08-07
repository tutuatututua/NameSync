"use client";

import * as React from "react";

/**
 * Hold a value still for `delay`ms after the last change — one request per pause, not per keystroke.
 *
 * Lifted out of `SearchTab`, which had it privately and is now one of two callers; the other is
 * `Combobox`, where it is the whole reason a picker over 100k rows is affordable at all. Sharing it
 * matters more than the six lines saved: a debounce that differs between two search boxes on the
 * same page is a difference nobody can see and everybody feels.
 */
export function useDebouncedValue<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}
