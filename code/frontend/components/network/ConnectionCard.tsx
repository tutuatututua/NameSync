import { ArrowRight, UserCheck, UserSearch } from "lucide-react";
import {
  compareByAxes,
  compareByLabel,
  hasThai,
  LANGUAGE_LABEL,
  matchReason,
  matchStrength,
  parseCompareBy,
  scoreQualifier,
  type CompareLanguage,
  type ConnectedUploader,
} from "@extensions/contract";
import { MarkedName } from "@/components/marked-name";
import { Side } from "@/components/pair-side";
import { Provenance } from "@/components/provenance";
import { Score } from "@/components/score";
import { formatSimilarity } from "@/lib/format";
import { cn } from "@/lib/utils";

/** The contact side of the pairing — a company person's two spellings, as they are on file today. */
export type PairedContact = {
  person_name_en: string | null;
  person_name_th: string | null;
  /** Where they work — named only in the contact label's tooltip, so a reader who cannot place
   *  "contact" can see which of the two names is the one at the company. Optional because the
   *  pairing reads correctly without it, and a caller holding no employer must not be forced to
   *  invent one. */
  company_name?: string | null;
};

/**
 * ONE CONNECTION, SPELLED OUT: whose friend, called what, held against which spelling of this
 * contact, under what comparison, and who put the roster in the database.
 *
 * ── Why this exists next to `KnownByBadge` rather than replacing it ──
 *
 * The chip answers "who knows this person" in the width of a name, and that is the right answer in
 * Search, where a result is one line and connections wrap several to a row. On the company page the
 * question is different in kind. You are already at one company looking at one contact; what you
 * are deciding is whether to act on a specific claim — and the chip's `tua · 94%` withholds exactly
 * what deciding needs:
 *
 *   · WHICH FRIEND. The number was earned by a name, and the chip does not say which one. On a
 *     surname run, `tua · surname 94%` beside `sunisa phongphaew` is unfalsifiable by the reader:
 *     it means something entirely different once you can see tua's friend is `nattapong
 *     phongphaew` (a different person, same family name) rather than `sunisa phongphaew`.
 *   · AGAINST WHAT. A contact has two spellings and a run compares ONE of them. Showing the
 *     English name beside a `th_*` score attaches the number to a string that was never scored.
 *   · WHOSE, AND FROM WHOM. Owner and importer are two people (that is the entire reason the
 *     column pair exists) and the chip could only afford to show one, so the second lived in a
 *     tooltip — invisible on touch, invisible in a screenshot, and invisible to anyone who did not
 *     already suspect there was a second name to look for.
 *
 * A row has room to say all four, so it says all four. The grading vocabulary is unchanged —
 * `matchStrength` from the contract, the same green/amber and check/search glyph the chips use —
 * because a connection that reads "confirmed" here and "lead" one screen over would be two answers
 * to one question.
 */
export function ConnectionCard({
  uploader,
  contact,
}: {
  uploader: ConnectedUploader;
  contact: PairedContact;
  /* A `threshold` prop stood here and went no further than the provenance strip below, which now
     reads the bar off the URL itself — see `Provenance`. Passing it was the shape that let the run
     page forget to, so there is nothing to pass. */
}) {
  const mode = parseCompareBy(uploader.mode);
  const { language, type } = compareByAxes(mode);
  const confirmed = matchStrength(mode) === "confirmed";
  const score = formatSimilarity(uploader.similarity);
  const Icon = confirmed ? UserCheck : UserSearch;

  /**
   * THE LANGUAGE THIS PAIRING WAS ACTUALLY COMPARED IN — which is not always the one its mode says.
   *
   * `mode` is the run's CONFIGURATION. `uploader.friend` is the frozen spelling the matcher recorded
   * on the same row as the score. When those two disagree the evidence wins, for the same reason
   * `runRowBucketSql` lets a stored match override an inference about script: the configuration is
   * what we asked for, the recorded name is what happened.
   *
   * They disagree in the live database. `comparison_result` row 297 is a `th_name` run carrying
   * the Latin string `narong sinthu` as its only friend name and `person_name_th` null — an
   * external workflow that ignored `compare_by` and scored two Latin strings. (It held that name
   * in a `friend_name` column until 2026-08-03c; the backfill filed it under `friend_name_en`,
   * by its script, which is why the row still reads as English here and why `scoredNameSql`
   * coalesces rather than returning null for the Thai column the mode asks for.)
   *
   * Trusting the mode there rendered `narong sinthu → ณรงค์ สินธุ`: an English name paired
   * with a Thai one, 100% between them, and the Thai half was never in the comparison at all. It
   * came from the contact's record as it stands TODAY, while the left half came from the run — two
   * sources for one claim, which is the defect, not the language tag.
   *
   * The script test is the documented fallback for a bare name with no column beside it (see
   * `isScorable`), and this is exactly that case: `ConnectedUploader` carries one friend string and
   * no marker saying which column it came out of.
   */
  const recordedLanguage: CompareLanguage = uploader.friend
    ? hasThai(uploader.friend)
      ? "th"
      : "en"
    : language;
  /** True when the run's mode and its own recorded evidence disagree — said on the card, not hidden. */
  const languageMismatch = recordedLanguage !== language;

  /*
   * THE SPELLING THIS RUN ACTUALLY SCORED — the language axis picks a column on the contact side
   * (see `compare-by.ts`), so an `en_*` run held the friend against `person_name_en` and never
   * looked at the Thai one.
   *
   * Keyed off `recordedLanguage` rather than the mode's, so BOTH HALVES OF THE PAIRING ARE ALWAYS IN
   * ONE SCRIPT. A card showing a Latin name against a Thai one is not a subtle mislabel — it is two
   * strings that were demonstrably never compared, with a percentage between them.
   *
   * The fallback is for the case where that column is empty today: the run matched on the other
   * spelling, or the contact has since been edited. Then the pairing shows what there is and drops
   * the language tag rather than labelling a Thai string "English" — the tag is a claim about which
   * comparison happened, and it must not survive the substitution that makes it false.
   */
  const scored = recordedLanguage === "th" ? contact.person_name_th : contact.person_name_en;
  const other = recordedLanguage === "th" ? contact.person_name_en : contact.person_name_th;
  const contactName = scored ?? other;
  const reason = matchReason(mode, score, { corroborated: uploader.corroborated });

  /**
   * WHAT THE NUMBER MEASURED, IN FULL — the part of the name AND the language it was taken in.
   *
   * A `compareByLabel(mode)` line used to sit under the pairing carrying this ("Name · Thai"), and
   * it stopped earning its line the moment every score began naming its own unit: `Name · Thai` under
   * a chip already reading `given name 100%` states the TYPE twice, in two vocabularies, two inches
   * apart. The language was the only word on that line still doing work, so it moves into the chip
   * and the line goes.
   *
   * It is the RECORDED language, not the mode's — same precedence as the pairing above it, and for
   * the same reason: this string sits directly beside the number, and labelling a score "Thai" when
   * the two strings it was taken between are Latin is the exact claim this component just stopped
   * making one line up.
   *
   * `KnownByBadge` deliberately does NOT do this and keeps language in its tooltip — a chip wraps
   * several to a row and the name is what gets scanned for. The card has a line to itself and its
   * whole thesis is that a decision needs all four facts spelled out; the two are not in conflict.
   */
  /**
   * WHAT THE NUMBER MEASURED — or null, when this row is in no position to say.
   *
   * Null is the whole subtlety here, and it exists because the first version of this line was
   * incoherent. It read `given name · English`, and those two words came from opposite authorities:
   * `given name` from the run's configured mode, `English` from a script test of the name the
   * matcher recorded. The second overrules the first — that is the point of `recordedLanguage` — so
   * keeping `given name` meant trusting the type axis of a mode whose language axis the same row had
   * just disproved. A reader who asks where "English" comes from on a Thai run is asking the right
   * question, and the honest answer was "half configuration, half guess".
   *
   * When the two agree, the mode is corroborated by its own output and the unit is fully backed.
   * When they disagree, the row records the two names and the number and NOTHING about which part of
   * them was compared — `narong sinthu` against `narong sinthu` scores 100% as a full name, a given
   * name, or a surname, and the three are indistinguishable from what is stored. So the chip states
   * the number alone and the caveat line below carries the reason.
   *
   * The alternative was to keep printing `given name` on the run's say-so. That is a label the row
   * cannot support, and an unsupported label is worse than an absent one: it survives screenshots,
   * and it is exactly the kind of claim the rest of this component was rewritten to stop making.
   */
  const unit = languageMismatch
    ? null
    : `${scoreQualifier(mode)} · ${LANGUAGE_LABEL[recordedLanguage]}`;

  /**
   * The friend's other spelling, shown only when it says something the pairing does not.
   *
   * Suppressed when it is identical to the scored name — a friend whose two columns hold the same
   * string would otherwise render `narong sinthu (narong sinthu)`, which is noise dressed as a
   * disclosure.
   */
  const altSpelling =
    uploader.friendAlt && uploader.friendAlt !== uploader.friend ? uploader.friendAlt : null;

  /**
   * THE CONTACT'S OTHER SPELLING — the same disclosure, on the side that was missing it.
   *
   * This was deliberately left off, on the grounds that the group header directly above the card
   * already prints both of the contact's spellings. Two things were wrong with that.
   *
   * The first is the asymmetry itself. An `en` run renders the friend as `orapin wongwanich (อรพิน
   * วงศ์วานิช)` and the contact as `wilai vongvanij` — one side declaring a Thai spelling and the
   * other silent — and the plain reading of that is "we hold no Thai name for this contact", which
   * is false whenever the header two lines up is showing one. The reader who spotted it read it
   * exactly that way.
   *
   * The second is that the header is not a substitute. It prints the contact's names as the record
   * holds them TODAY, in reading order; the card prints the spelling THIS RUN SCORED, chosen by
   * `recordedLanguage`. Those are different claims that happen to coincide most of the time, and
   * asking the reader to pair them up by eye — across a group header, past a `Known by 2 friends`
   * line, over another card — is asking them to do the one piece of work this card exists to do.
   *
   * Null when the pairing is already showing the fallback (`scored` empty, so `contactName` IS the
   * other spelling): there is nothing left to disclose and the note below says why.
   */
  const contactAlt = scored && other && other !== scored ? other : null;

  /**
   * WHICH OF THESE TWO IS THE ONE AT THE COMPANY — said in a word, on the face of the card.
   *
   * Not a small point on a Thai roster: `orapin wongwanich → wilai vongvanij` is two lowercase
   * transliterations with an arrow between them, and nothing in the strings, the order or the
   * colour says which is the colleague's friend and which is the stranger you want introducing to.
   * Read backwards, the card claims a relationship that does not exist — and it still carries a
   * percentage while doing it.
   *
   * The employer goes in the tooltip rather than the label. It is the title of the page these
   * cards are on, so printing `at BANGKOK BANK` on every one of them repeats the heading a dozen
   * times a screen, and a long registered company name would set the label wider than the names it
   * introduces.
   */
  const contactHint = contact.company_name
    ? `The person on file at ${contact.company_name} — the contact this card is about.`
    : "The person at the company — the contact this card is about.";

  /**
   * The caveats — rendered only when there is one, so an ordinary card is three lines and not four.
   *
   * Both are statements about how far the pairing above departs from what the run asked for, which
   * is why they share a line and a colour rather than living in the mode label that used to hold
   * them. Neither is reachable on a healthy run written by the internal matcher.
   */
  const notes: { text: string; title: string }[] = [];
  if (languageMismatch) {
    notes.push({
      text: `set to compare ${compareByLabel(mode)}, but recorded ${
        LANGUAGE_LABEL[recordedLanguage]
      } names — what this score measured is unconfirmed`,
      title: `This run's mode is ${compareByLabel(mode)}, and the matcher recorded ${
        LANGUAGE_LABEL[recordedLanguage]
      } spellings for this pairing — so it did not follow the mode. Nothing on the row records which part of the names it did compare, which is why the score above carries no unit. Treat the number as a resemblance between the two names shown, and check the pairing before acting on it.`,
    });
  }
  if (!scored && contactName) {
    notes.push({
      text: "compared on the contact's other spelling",
      title: `This contact has no ${LANGUAGE_LABEL[recordedLanguage]} name on file today, so the pairing shows the spelling that survives rather than the one the run scored.`,
    });
  }

  return (
    <div
      className={cn(
        "space-y-2 rounded-md border p-3",
        confirmed ? "border-confidence-high/25 bg-confidence-high/5" : "border-confidence-medium/25 bg-confidence-medium/5"
      )}
    >
      <div className="flex items-start gap-2">
        <Icon
          className={cn(
            "mt-0.5 h-4 w-4 shrink-0",
            confirmed ? "text-confidence-high" : "text-confidence-medium"
          )}
          aria-hidden
        />

        {/* THE PAIRING. Friend on the left, contact on the right, the arrow between them meaning
            "was compared against" — and both sides marked through `MarkedName`, so on a partial
            run the reader sees the two tokens that were actually held against each other rather
            than two whole names with a percent between them.

            Each side wears its role in front of it, through the same `Side` the run table uses, so
            "which of these two is the person at the company" has one answer and one wording
            wherever a pairing is rendered. The label stays with its name when the row wraps, which
            is the case it exists for: a wrapped pairing degrades into two labelled lines instead of
            two anonymous ones. */}
        <div className="min-w-0 flex-1 space-y-1">
          <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
            <Side
              label="friend"
              hint={`Someone ${uploader.name} knows — the name this run held against the contact. Ask them for the introduction.`}
            >
              {uploader.friend ? (
                <span className="inline-flex min-w-0 flex-wrap items-baseline gap-x-1.5">
                  <MarkedName
                    name={uploader.friend}
                    type={type}
                    lang={recordedLanguage === "th" ? "th" : undefined}
                    alt={uploader.friendAlt}
                    className="font-medium"
                  />
                  {/* The same person's other spelling, ON THE CARD rather than only in the title.
                      A `th_name` run whose workflow ignored `compare_by` records Latin names, so the
                      pairing above is honest and unrecognisable — `narong sinthu` where the reader
                      knows `ณรงค์ สินธุ`. Muted, unmarked and parenthesised so it cannot be mistaken
                      for the string that earned the score; `MarkedName` deliberately does not run
                      over it, because no part of it was compared. */}
                  {altSpelling && (
                    <span
                      lang={recordedLanguage === "th" ? undefined : "th"}
                      className="text-muted-foreground"
                      title={`Also on file as ${altSpelling}. This spelling was not the one scored.`}
                    >
                      ({altSpelling})
                    </span>
                  )}
                </span>
              ) : (
                // A run that recorded no name for its own side. The connection still stands — being
                // in this list is what says so — but the pairing cannot be written, and naming the
                // friend "unknown" is more honest than quietly showing the owner's name in the slot
                // where a friend's name belongs.
                <span className="italic text-muted-foreground" title="This run recorded no name for the friend it matched.">
                  friend name not recorded
                </span>
              )}
            </Side>

            <ArrowRight className="h-3.5 w-3.5 shrink-0 self-center text-muted-foreground" aria-label="was compared against" />

            <Side label="contact" hint={contactHint}>
              {contactName ? (
                <span className="inline-flex min-w-0 flex-wrap items-baseline gap-x-1.5">
                  <MarkedName
                    name={contactName}
                    type={type}
                    lang={scored && recordedLanguage === "th" ? "th" : undefined}
                    className="font-medium"
                  />
                  {/* Rendered exactly like the friend's — same parentheses, same muted grey, same
                      absence of the underline — because it is the same fact about the other half of
                      the pairing: a spelling we hold for this person that this run did not score. A
                      quieter treatment on this side would be the asymmetry all over again. */}
                  {contactAlt && (
                    <span
                      lang={recordedLanguage === "th" ? undefined : "th"}
                      className="text-muted-foreground"
                      title={`Also on file as ${contactAlt}. This spelling was not the one scored.`}
                    >
                      ({contactAlt})
                    </span>
                  )}
                </span>
              ) : (
                <span className="text-muted-foreground">this contact</span>
              )}
            </Side>
          </p>

          {/* The caveats, and ONLY when there are any — what the comparison was is stated once, in
              the chip to the right. Amber because each one says the pairing above departs from what
              the run was configured to do; a reader who trusts the run's settings without being
              told would be reading a Thai claim off a pair of Latin strings. */}
          {notes.length > 0 && (
            <p className="text-xs text-confidence-medium">
              {notes.map((n, i) => (
                <span key={n.text} title={n.title}>
                  {i > 0 && " · "}
                  {n.text}
                </span>
              ))}
            </p>
          )}
        </div>

        {/*
          The score, through the SAME component the run-results table uses — so the hue on a
          percentage means one thing everywhere in the product: how close the two names came.

          It used to be tinted by `confirmed` instead, i.e. by the STRENGTH of the mode, and the
          result was a card reading "80%" in green sitting above one reading "100%" in amber. Both
          colours were defensible on their own terms — an 80% whole-name match really is better
          evidence than a 100% given-name match — but `--confidence-*` is the same ramp the results
          page uses for the score itself, so the product had one palette carrying two meanings and no
          way for a reader to know which was in play. The first person to see the two cards together
          asked why the smaller number was the greener one.

          Strength has not been dropped; it has been moved off the number, which was the wrong place
          for it. It is still the card's border and background, still the icon, and still the whole
          subject of the tooltip — and the chip's own unit names the mode's type outright, which is
          the plainest statement of it on the card. Those say "weak KIND of evidence" without
          contradicting the number beside them.

          Dropped, not dashed, when no run recorded a score — `Score` renders a dash for null, which
          holds a table column open and is not what a card wants.
        */}
        {score && (
          <span title={reason} className="mt-0.5 shrink-0">
            <Score value={uploader.similarity} qualifier={unit} />
          </span>
        )}
      </div>

      {/* PROVENANCE, on the face and not in a tooltip — through `Provenance`, which is also what a
          run row shows, so "who owns this / who filed it" is one strip with one wording wherever a
          connection is rendered. The argument for always showing both names, and for never
          back-filling one from the other, moved into that component with the markup. */}
      <Provenance owner={uploader.name} uploadedBy={uploader.uploadedBy} />
    </div>
  );
}
