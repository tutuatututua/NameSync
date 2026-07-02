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
    <html lang="en" suppressHydrationWarning>
      <body className={`${sans.variable} ${mono.variable} ${thai.variable} antialiased`}>
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          <Providers>{children}</Providers>
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
