import { describe, it, expect, afterEach, vi } from "vitest";
import { join } from "node:path";
import {
  runDownloadMusic,
  step as downloadMusicStep,
} from "@/worker/steps/download-music";
import {
  cleanup,
  freshDb,
  tempDir,
} from "../../../helpers/step-fixtures";
import type { Database as DatabaseType } from "better-sqlite3";

afterEach(cleanup);

function seedMusicVideo(db: DatabaseType, songCount: number | null): string {
  const now = Date.now();
  // The workflow row is FK-referenced; the seeded `music-video-magnific-suno`
  // already exists in the default schema after Phase 1.1.
  db.prepare(
    `INSERT INTO videos
       (id, title, topic_info, workflow_id, status, kind, song_count, repeat_factor, created_at)
     VALUES (?, ?, '', ?, 'in_progress', 'music_video', ?, 3, ?)`
  ).run("v_dl_01", "Test", "music-video-magnific-suno", songCount, now);
  return "v_dl_01";
}

describe("download_music (music-video stub)", () => {
  it("exports a Step with the music_video metadata contract", () => {
    expect(downloadMusicStep.name).toBe("download_music");
    expect(downloadMusicStep.module).toBe("music_video");
    expect(downloadMusicStep.inputs ?? []).toEqual([]);
    expect(downloadMusicStep.outputs).toEqual(["songs/"]);
  });

  it("invokes ffmpeg song_count times with lavfi anullsrc args, one file per song", async () => {
    const db = freshDb();
    const projectsDir = tempDir("dl-music");
    const videoId = seedMusicVideo(db, 3);
    const exec = vi.fn().mockResolvedValue(undefined);

    await runDownloadMusic(videoId, { db, projectsDir, exec });

    expect(exec).toHaveBeenCalledTimes(3);
    const seenPaths: string[] = [];
    for (const call of exec.mock.calls) {
      const args = call[0] as string[];
      expect(args).toContain("-f");
      expect(args).toContain("lavfi");
      expect(args).toContain("-i");
      expect(args).toContain("anullsrc=channel_layout=stereo:sample_rate=44100");
      expect(args).toContain("-t");
      expect(args).toContain("1");
      seenPaths.push(args[args.length - 1]);
    }
    expect(seenPaths).toEqual([
      join(projectsDir, videoId, "songs", "song_01.wav"),
      join(projectsDir, videoId, "songs", "song_02.wav"),
      join(projectsDir, videoId, "songs", "song_03.wav"),
    ]);
  });

  it("pads the index in the filename to two digits", async () => {
    const db = freshDb();
    const projectsDir = tempDir("dl-music-pad");
    const videoId = seedMusicVideo(db, 1);
    const exec = vi.fn().mockResolvedValue(undefined);

    await runDownloadMusic(videoId, { db, projectsDir, exec });

    const outPath = (exec.mock.calls[0][0] as string[]).pop();
    expect(outPath).toBe(
      join(projectsDir, videoId, "songs", "song_01.wav")
    );
  });

  it("throws when song_count is null", async () => {
    const db = freshDb();
    const projectsDir = tempDir("dl-music-nullcount");
    const videoId = seedMusicVideo(db, null);
    const exec = vi.fn();

    await expect(
      runDownloadMusic(videoId, { db, projectsDir, exec })
    ).rejects.toThrow(/song_count/i);
    expect(exec).not.toHaveBeenCalled();
  });

  it("throws when the video row is missing", async () => {
    const db = freshDb();
    const projectsDir = tempDir("dl-music-missing");

    await expect(
      runDownloadMusic("v_missing", { db, projectsDir, exec: vi.fn() })
    ).rejects.toThrow(/v_missing/);
  });
});
