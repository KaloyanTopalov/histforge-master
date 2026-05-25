import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';
import UploadReadyBadge from './upload-ready-badge';
import SunoCookieRotatedBanner from './suno-cookie-rotated-banner';

export const metadata: Metadata = {
  title: 'AmbientForge',
  description: 'Multi-channel YouTube music empire automation',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
        <SunoCookieRotatedBanner />
        <header className="border-b border-zinc-200 dark:border-zinc-800">
          <nav className="mx-auto flex max-w-5xl items-center gap-6 px-6 py-4">
            <Link href="/channels" className="font-semibold tracking-tight">
              AmbientForge
            </Link>
            <Link
              href="/channels"
              className="text-sm text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
            >
              Channels
            </Link>
            <Link
              href="/settings"
              className="text-sm text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
            >
              Settings
            </Link>
            <UploadReadyBadge />
          </nav>
        </header>
        <main className="mx-auto max-w-5xl px-6 py-8">{children}</main>
      </body>
    </html>
  );
}
