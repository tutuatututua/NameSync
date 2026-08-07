import type { ImportPrecheck } from "@extensions/contract";
import { CompanyContactModel, type CompanyContactRecord } from "../models/company-contact.model";
import { FriendModel, type FriendRecord } from "../models/friend.model";
import type { PriorImport } from "../models/upload.model";

/**
 * "What of this file is already here?" — computed once, read twice.
 *
 * The import screen calls this through `POST /preview` to say what will happen, and `POST /run`
 * calls it to decide whether there is anything to do. ONE function, because a screen that says "go
 * ahead" over a server that answers 400 is a product bug that no amount of matching copy prevents.
 *
 * ── WHAT IT DOES CHANGED ON 2026-08-05 (twice, in one day) ──
 *
 * It began as "has this COMPARISON been run?", which only made sense while an import carried a
 * comparison mode. It briefly became "have these PEOPLE been filed by you?", enforced as a hard
 * refusal of the whole file. It is now neither: duplicate ROWS are dropped at write time
 * (`FriendModel.dropMask`), and this reports which ones so the reader can see them before
 * committing rather than discovering the count afterwards.
 *
 * The refusal survives in exactly one case — a file where EVERY row would be dropped, which is an
 * import that would write nothing at all. That is not a rule about repetition, it is the ordinary
 * "there is nothing here to import" this endpoint already applies to an empty file.
 *
 * ── WHY DROPPING BEAT REFUSING ──
 *
 * A refusal is all-or-nothing over a file, and files are mixed: 40 rows you already have and 10 you
 * do not is the common shape, and neither "refuse it" nor "write all 50 again" is the right answer
 * to it. Dropping is per row, so the answer is 10 — and the reader is told which 40 and why.
 */

/** What the caller knows about the import it is about to make. */
export interface PrecheckInput {
  /**
   * The rows that would actually be written — nameless ones already dropped by the caller, and a
   * typed relationship-owner override already applied, since the owner is part of the key.
   *
   * `source` rides with the friends side because it is part of the key too, and the import defaults
   * it: a friends import with no type chosen stores 'facebook', so asking about anything else would
   * compare the file against rows filed under a source it is not going to use.
   */
  records:
    | { kind: "company"; rows: CompanyContactRecord[] }
    | { kind: "social"; rows: FriendRecord[]; source: string };
  /**
   * Who is performing THIS import — resolved exactly as `POST /run` resolves it.
   *
   * Part of the duplicate key, which is why it is required rather than optional: a caller that
   * could omit it would get an answer to a weaker question, and the weaker answer is the one that
   * drops nothing.
   */
  uploadedBy: string | null;
}

/** The stored row's columns, as the wire spells them. */
const onWire = (u: PriorImport | null): ImportPrecheck["priorImport"] =>
  u === null ? null : { id: u.id, name: u.name, uploadedBy: u.uploaded_by, createdAt: u.created_at };

export class ImportPrecheckService {
  static async run(input: PrecheckInput): Promise<ImportPrecheck> {
    const { records, uploadedBy } = input;
    const importableRows = records.rows.length;

    /**
     * The mask and the provenance, asked together.
     *
     * `drop` is the answer this screen exists to give — WHICH rows, in file order, so the preview
     * can mark them rather than printing a number. It comes from the same function `mergeUpload`
     * derives its inserts from, so the screen and the import cannot disagree.
     *
     * `known` is only for the sentence above the list ("you imported these on 4 August"). It uses
     * the looser PERSON identity deliberately: the reader wants to be pointed at the import they
     * are repeating, and that import is the one holding these people — not necessarily one holding
     * a byte-identical row.
     */
    const [drop, known] =
      records.kind === "company"
        ? await Promise.all([
            CompanyContactModel.dropMask(records.rows, uploadedBy),
            CompanyContactModel.countKnown(records.rows, { uploadedBy }),
          ])
        : await Promise.all([
            FriendModel.dropMask(records.rows, records.source, uploadedBy),
            FriendModel.countKnown(records.rows, { uploadedBy }),
          ]);

    const duplicateRows = drop.filter(Boolean).length;

    return {
      importableRows,
      /** Rows that would actually be written — the size of the job, and of the run over it. */
      newRows: importableRows - duplicateRows,
      duplicateRows,
      /**
       * WHICH ones, in file order.
       *
       * Indexes rather than a parallel boolean array: the preview shows only the first few rows, so
       * the reader needs "row 3 and row 7 of what you are looking at" and a caller needs to be able
       * to slice it without the two arrays silently falling out of step.
       */
      duplicateIndexes: drop.flatMap((d, i) => (d ? [i] : [])),
      priorImport: onWire(known.priorImport),
    };
  }

  /**
   * The message for the one case that is still refused — a file with nothing left to write.
   *
   * It names the import the rows came from and the two things that would make this file new, both
   * of which are real changes to what gets recorded rather than ways past a check. It does NOT
   * offer "import anyway": there is no anyway. Every row would be dropped, so forcing it through
   * would create an empty import and a run over nothing.
   *
   * The last sentence names a CONTROL, so it has to be checked against the app whenever one moves —
   * a refusal that sends the reader to a button that is not there costs them the trip. It has been
   * wrong twice in one day: it said "use Find connections on the Network page" until that button
   * was removed on 2026-08-06, then pointed at the Uploads table's own Compare, which went the same
   * day. Runs are started from Network → Results. `ImportReview` renders its own copy of this
   * advice and must say the same thing.
   */
  static refusalMessage(p: ImportPrecheck): string {
    const when = p.priorImport
      ? `on ${new Date(p.priorImport.createdAt).toISOString().slice(0, 10)}`
      : "already";
    const what = p.priorImport?.name ? `“${p.priorImport.name}”` : "this data";

    return (
      `Every row in this file is already on file, imported by you ${when} as ${what} — so there is ` +
      `nothing to import. If these friends belong to someone else, put their name in “Relationship ` +
      `owner”; if someone else is importing, change “Uploaded by”. To compare what is already here ` +
      `— in Thai, or on surnames — press Compare on the earlier import’s run under Network → ` +
      `Results.`
    );
  }
}
