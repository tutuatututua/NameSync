import { namePartSpan, type CompareType } from "@extensions/contract";

/**
 * A name with the part that was actually compared picked out.
 *
 * A last-name match on "somchai jaidee" ↔ "narong jaidee" looks like a bug until you can see that
 * only "jaidee" was ever in play. The span comes from `namePartSpan` in the shared contract — the
 * same function the matcher splits on — so the highlight cannot claim a different reading from the
 * one that was scored. Re-deriving it here is safe precisely because the split is computed at
 * query time from the stored string rather than baked into a column.
 *
 * On a `full` run there is no part to pick out and this is the plain name, without markup nobody
 * needs.
 *
 * ── Why it is shared ──
 *
 * It was private to the run table, which was where a mode-aware reading of a name first existed.
 * The company page now states each connection as a pairing ("this friend ↔ this contact"), and a
 * pairing that does not mark the compared span is the exact defect this component was written to
 * fix, one screen over: two whole names shown side by side, 94% between them, and no way to tell
 * that only the surnames were ever held against each other. Two implementations of the underline
 * would be two readings of one split — so there is one, here.
 */
export function MarkedName({
  name,
  type,
  lang,
  alt,
  className,
}: {
  name: string | null;
  type: CompareType;
  lang?: string;
  /** The same person's other spelling, when there is one this row is not showing. It goes in the
   *  title rather than on the row: a second name line on every row costs height on all of them for
   *  something the run's finding does not depend on. */
  alt?: string | null;
  className?: string;
}) {
  if (!name) return <span className="text-muted-foreground">—</span>;
  const span = type === "full" ? null : namePartSpan(name, type);
  const title = alt && alt !== name ? `${name} — also on file as ${alt}` : name;

  if (!span || !span.before) {
    return (
      <span lang={lang} className={className} title={title}>
        {name}
      </span>
    );
  }

  return (
    <span lang={lang} className={className} title={title}>
      <span className="text-muted-foreground/60">{span.before}</span>
      <span className="underline decoration-primary/40 decoration-2 underline-offset-4">{span.match}</span>
      <span className="text-muted-foreground/60">{span.after}</span>
    </span>
  );
}
