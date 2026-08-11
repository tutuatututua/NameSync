import type { Metadata } from "next";
import { TwoFactorCard } from "@/components/settings/two-factor-card";

export const metadata: Metadata = { title: "Settings · Network Intel" };

/**
 * /settings — the account settings page, reached from the user menu.
 *
 * One section today (two-factor authentication); the layout is a single column with room to
 * grow as more settings arrive. The card shows whether 2FA is on before asking for anything —
 * checking the setting is the reason most people open this page.
 */
export default function SettingsPage() {
  return (
    <div className="mx-auto w-full max-w-2xl space-y-6 py-2">
      <div>
        <h1 className="font-display text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Your sign-in security. Your password and second factor live in your Center account —
          changes made here apply there too.
        </p>
      </div>

      <TwoFactorCard />
    </div>
  );
}
