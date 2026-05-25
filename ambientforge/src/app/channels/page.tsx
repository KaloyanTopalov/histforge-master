import Link from 'next/link';
import { list } from '@/lib/repos/channels';
import { getMostRecentByChannel } from '@/lib/repos/albums';

export const dynamic = 'force-dynamic';

export default function ChannelsPage() {
  const channels = list();
  const rows = channels.map((c) => ({
    channel: c,
    latestAlbum: getMostRecentByChannel(c.id),
  }));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Channels</h1>
        <Link
          href="/channels/new"
          className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          New channel
        </Link>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-md border border-dashed border-zinc-300 p-12 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
          No channels yet. Click <span className="font-semibold">New channel</span> to add one.
        </div>
      ) : (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-zinc-200 text-left dark:border-zinc-800">
              <th className="py-2 pr-4">Name</th>
              <th className="py-2 pr-4">Display name</th>
              <th className="py-2 pr-4">Active</th>
              <th className="py-2 pr-4">Schedule</th>
              <th className="py-2 pr-4">DistroKid artist</th>
              <th className="py-2 pr-4">Latest album</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ channel, latestAlbum }) => (
              <tr key={channel.id} className="border-b border-zinc-100 dark:border-zinc-900">
                <td className="py-2 pr-4 font-mono">
                  <Link
                    href={`/channels/${channel.id}`}
                    className="hover:underline"
                  >
                    {channel.name}
                  </Link>
                </td>
                <td className="py-2 pr-4">{channel.displayName}</td>
                <td className="py-2 pr-4">{channel.active ? 'yes' : 'no'}</td>
                <td className="py-2 pr-4 font-mono text-xs">{channel.scheduleCron}</td>
                <td className="py-2 pr-4">{channel.distrokidArtistName}</td>
                <td className="py-2 pr-4 font-mono text-xs">
                  {latestAlbum ? latestAlbum.status : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
