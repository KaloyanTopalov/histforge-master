import { Suspense } from "react";
import { getAllSettings, type AllSettings } from "@/lib/settings";
import { SettingsForm } from "./settings-form";
import { Card, CardContent } from "@/components/ui/card";

/**
 * Settings page. Server-component snapshot of every setting key, handed
 * to a client form that PATCHes back on save. Spec `:724-726`.
 */
export default function SettingsPage(): JSX.Element {
  const settings: AllSettings = getAllSettings();
  return (
    <>
      <header className="relative mb-8 pb-5">
        <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-emerald-800/85 dark:text-emerald-300/85">
          Configuration
        </p>
        <h1 className="mt-1.5 font-display text-[2.75rem] font-medium leading-[1.05] tracking-tight text-foreground">
          Settings
        </h1>
        <span
          aria-hidden="true"
          className="absolute inset-x-0 bottom-0 h-px bg-emerald-500/35 dark:bg-emerald-400/40"
        />
      </header>
      <Card className="overflow-hidden border border-[hsl(220_28%_84%)] bg-gradient-to-br from-[hsl(218_45%_97%)] via-[hsl(222_35%_96%)] to-[hsl(228_30%_93%)] shadow-[0_12px_30px_-15px_rgba(15,23,42,0.18)] ring-1 ring-[hsl(160_60%_30%/0.06)] dark:border-[hsl(222_22%_22%)] dark:bg-gradient-to-br dark:from-[hsl(222_25%_14%)] dark:via-[hsl(225_22%_12%)] dark:to-[hsl(228_22%_9%)] dark:shadow-[0_18px_36px_-18px_rgba(0,0,0,0.6)] dark:ring-emerald-300/[0.05]">
        <CardContent className="pt-6">
          <Suspense fallback={null}>
            <SettingsForm initial={settings} />
          </Suspense>
        </CardContent>
      </Card>
    </>
  );
}
