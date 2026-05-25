import { getSettings, getRawSetting, maskSecret } from '@/lib/settings';
import SettingsForm from './settings-form';

export const dynamic = 'force-dynamic';

function parseBrollRoots(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((p) => typeof p === 'string')) return parsed;
  } catch {
    /* fall through */
  }
  return [];
}

export default function SettingsPage() {
  const settings = getSettings();
  const initial = {
    queue_state: settings.queue_state,
    scheduler_enabled: settings.scheduler_enabled,
    openrouter_api_key_masked: maskSecret(settings.openrouter_api_key || undefined),
    model_name: settings.model_name,
    distrokid_dry_run: settings.distrokid_dry_run,
    content_id_hold_days: settings.content_id_hold_days,
    broll_allowed_root_paths: parseBrollRoots(getRawSetting('broll_allowed_root_paths')),
  };
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
      <p className="text-sm text-zinc-500 dark:text-zinc-400">
        Defaults are seeded by <code>npm run db:init</code>. Changes here persist to the{' '}
        <code>settings</code> table.
      </p>
      <SettingsForm initial={initial} />
    </div>
  );
}
