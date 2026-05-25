import type { ReactNode } from "react";
import { Fraunces, JetBrains_Mono, Sora } from "next/font/google";
import "./globals.css";
import { NavBar } from "./nav-bar";
import { Toaster } from "@/components/ui/sonner";
import { ThemeProvider } from "@/components/theme-provider";

// Sora — geometric sans for body. Distinctive but neutral enough to read all day.
const sora = Sora({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-sans",
  weight: ["300", "400", "500", "600", "700", "800"],
});

// Fraunces — variable serif with optical sizing. Used for display headings;
// gives the dashboard an editorial / historical feel without leaning generic.
// `axes` requires the variable file, so we don't pass `weight`.
const fraunces = Fraunces({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-display",
  axes: ["SOFT", "opsz"],
});

// JetBrains Mono — for setting IDs, codes, file paths.
const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-mono",
  weight: ["400", "500", "600"],
});

export const metadata = {
  title: "histforge",
  description:
    "Unattended pipeline that turns a one-line topic into a finished historical YouTube video.",
};

export default function RootLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${sora.variable} ${fraunces.variable} ${jetbrainsMono.variable}`}
    >
      <body className="font-sans antialiased">
        <ThemeProvider>
          <NavBar />
          <main className="mx-auto max-w-5xl px-4 py-6">{children}</main>
          <Toaster richColors />
        </ThemeProvider>
      </body>
    </html>
  );
}
