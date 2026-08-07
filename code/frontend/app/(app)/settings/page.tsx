import type { Metadata } from "next";
import { TwoFactorCard } from "@/components/settings/two-factor-card";

export const metadata: Metadata = { title: "Settings · Network Intel" };

/**
 * /settings — the account settings page, reached from the user menu.
 *
 * One section today (two-factor authentication); the layout is a single column with room to
 * grow as more settings arrive.
 */
export default function SettingsPage() {
  return (
    <div className="mx-auto w-full max-w-2xl space-y-6 py-2">
      <div>
        <h1 className="font-display text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">Manage your account security.</p>
      </div>

      <TwoFactorCard />
    </div>
  );
}
