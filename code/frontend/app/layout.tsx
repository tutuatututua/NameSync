import type { Metadata } from "next";
import { Inter, Geist_Mono, Noto_Sans_Thai } from "next/font/google";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";
import { Providers } from "./providers";
import { Toaster } from "@/components/ui/sonner";

// Inter for UI + headings (highly legible); Geist Mono for numbers; Noto Sans Thai fallback.
const sans = Inter({ variable: "--font-sans", subsets: ["latin"], display: "swap" });
const mono = Geist_Mono({ variable: "--font-mono", subsets: ["latin"] });
const thai = Noto_Sans_Thai({
  variable: "--font-thai",
  subsets: ["thai"],
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: "NameSync",
  description: "Sync and compare Company and Facebook data with confidence-scored name matching.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // The font variables belong on <html>, not <body>.
    //
    // Tailwind's preflight sets `html { font-family: var(--font-sans), … }`. next/font
    // defines --font-sans through a generated class, and while that class sat on <body> the
    // variable did not exist at <html> — so the declaration was invalid, the browser fell
    // back to its default, and every piece of unstyled body text in this app rendered in
    // Times New Roman. Only nodes carrying an explicit font-* utility escaped, because they
    // resolved the variable from inside <body>. Hoisting the classes one level up fixes it.
    <html
      lang="en"
      className={`${sans.variable} ${mono.variable} ${thai.variable}`}
      suppressHydrationWarning
    >
      <body className="antialiased">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          <Providers>{children}</Providers>
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
