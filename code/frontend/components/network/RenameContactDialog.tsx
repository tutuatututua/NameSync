"use client";

import * as React from "react";
import type { RenameContactBody } from "@extensions/contract";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { LoadingButton } from "@/components/loading-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useRenameContact } from "@/hooks/mutations";

/** The bits of a company contact this dialog edits. */
export interface EditableContact {
  id: string;
  company_name: string | null;
  person_name_en: string | null;
  person_name_th: string | null;
}

/**
 * Edit a company contact's name(s) or employer (Feature 3).
 *
 * Sends only the fields that changed, so an untouched name isn't needlessly re-cleaned. A contact
 * must keep at least one name and must keep a company, so the two impossible edits — blanking both
 * names, or clearing the company — simply can't be submitted. The server cleans what it stores
 * (lower-cased, honorifics stripped) so the edit stays matchable; the values shown here are the
 * stored ones, which is why they read normalized.
 */
export function RenameContactDialog({
  contact,
  open,
  onOpenChange,
}: {
  contact: EditableContact | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const rename = useRenameContact();
  const [en, setEn] = React.useState("");
  const [th, setTh] = React.useState("");
  const [company, setCompany] = React.useState("");

  // Re-seed whenever the dialog is opened on a different contact.
  React.useEffect(() => {
    setEn(contact?.person_name_en ?? "");
    setTh(contact?.person_name_th ?? "");
    setCompany(contact?.company_name ?? "");
  }, [contact]);

  if (!contact) return null;

  const base = {
    en: contact.person_name_en ?? "",
    th: contact.person_name_th ?? "",
    company: contact.company_name ?? "",
  };

  const body: RenameContactBody = {};
  if (en.trim() !== base.en) body.person_name_en = en.trim();
  if (th.trim() !== base.th) body.person_name_th = th.trim();
  // A company can't be cleared, so an emptied company is left out rather than sent.
  if (company.trim() && company.trim() !== base.company) body.company_name = company.trim();

  const nameless = !en.trim() && !th.trim();
  const hasChange = Object.keys(body).length > 0;
  const canSubmit = hasChange && !nameless && !rename.isPending;

  async function submit() {
    try {
      await rename.mutateAsync({ uuid: contact!.id, body });
      onOpenChange(false);
    } catch {
      /* the mutation surfaces the error as a toast */
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit contact</DialogTitle>
          <DialogDescription>
            Names are stored normalized (lower-cased, titles removed) so matching keeps working.
            Past comparison results are left unchanged — this affects future comparisons.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="contact-en" className="text-xs">
              English name
            </Label>
            <Input
              id="contact-en"
              value={en}
              onChange={(e) => setEn(e.target.value)}
              placeholder="e.g. somchai jaidee"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="contact-th" className="text-xs">
              Thai name
            </Label>
            <Input
              id="contact-th"
              value={th}
              onChange={(e) => setTh(e.target.value)}
              placeholder="ชื่อภาษาไทย"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="contact-company" className="text-xs">
              Company <span className="text-destructive">*</span>
            </Label>
            <Input
              id="contact-company"
              value={company}
              onChange={(e) => setCompany(e.target.value)}
              placeholder="Company name"
            />
          </div>

          {nameless && (
            <p className="text-sm text-destructive">A contact needs a Thai or English name.</p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={rename.isPending}>
            Cancel
          </Button>
          <LoadingButton variant="gradient" isLoading={rename.isPending} disabled={!canSubmit} onClick={submit}>
            Save changes
          </LoadingButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
