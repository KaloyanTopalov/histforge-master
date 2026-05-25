import { describe, it, expect, afterEach } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { createDb, seedDefaultSettings } from "@/lib/db";
import { setSetting } from "@/lib/settings";
import { getVideosPageState } from "@/lib/videos-page-state";
import * as gfRepo from "@/lib/repos/google-flow";

const openDbs: DatabaseType[] = [];
function freshDb(): DatabaseType {
  const db = createDb(":memory:");
  seedDefaultSettings(db);
  openDbs.push(db);
  return db;
}
afterEach(() => {
  while (openDbs.length) {
    try {
      openDbs.pop()!.close();
    } catch {
      // already closed
    }
  }
});

function seedVideo(
  db: DatabaseType,
  id: string,
  status: string,
  created_at: number
): void {
  db.prepare(
    "INSERT INTO videos (id, title, topic_info, workflow_id, status, created_at) VALUES (?, 'T', 'info', 'comfyui', ?, ?)"
  ).run(id, status, created_at);
}

describe("getVideosPageState", () => {
  it("returns videos with runtime_ms 0 and running_step_started_at null when no step snapshots exist", () => {
    const db = freshDb();
    seedVideo(db, "v1", "queued", 100);

    const state = getVideosPageState(db);

    expect(state.videos).toHaveLength(1);
    expect(state.videos[0].id).toBe("v1");
    expect(state.videos[0].runtime_ms).toBe(0);
    expect(state.videos[0].running_step_started_at).toBeNull();
  });

  it("projects runtime_ms and running_step_started_at from steps snapshots", () => {
    const db = freshDb();
    seedVideo(db, "v1", "in_progress", 100);
    db.prepare(
      "INSERT INTO video_steps (video_id, step_name, status, started_at, finished_at) VALUES (?, ?, 'done', ?, ?)"
    ).run("v1", "s1", 1000, 1500);
    db.prepare(
      "INSERT INTO video_steps (video_id, step_name, status, started_at, finished_at) VALUES (?, ?, 'running', ?, NULL)"
    ).run("v1", "s2", 2000);

    const state = getVideosPageState(db);

    expect(state.videos[0].runtime_ms).toBe(500);
    expect(state.videos[0].running_step_started_at).toBe(2000);
  });

  it("returns queueState top-level and groups banner flags under bannerFlags", () => {
    const db = freshDb();
    const initial = getVideosPageState(db);
    expect(initial.bannerFlags.flowCreateProjectFailed).toBe("");
    expect(initial.bannerFlags.googleFlowReloginNeeded).toBe(false);
    expect(initial.bannerFlags.flowServiceOverloadUntil).toBe("");

    setSetting("queue_state", "paused", db);
    setSetting("flow_create_project_failed", '{"err":"x"}', db);
    setSetting("google_flow_relogin_needed", true, db);
    setSetting("flow_service_overload_until", "1714150900", db);

    const after = getVideosPageState(db);
    expect(after.queueState).toBe("paused");
    expect(after.bannerFlags.flowCreateProjectFailed).toBe('{"err":"x"}');
    expect(after.bannerFlags.googleFlowReloginNeeded).toBe(true);
    expect(after.bannerFlags.flowServiceOverloadUntil).toBe("1714150900");
  });

  it("flowRecoveryAccounts is empty when no accounts are flagged", () => {
    const db = freshDb();
    expect(getVideosPageState(db).bannerFlags.flowRecoveryAccounts).toEqual([]);
  });

  it("flowRecoveryAccounts surfaces enabled flagged accounts oldest-first", () => {
    const db = freshDb();
    gfRepo.insertAccount(db, { id: "acc_01", name: "A", token: "t1", created_at: 1 });
    gfRepo.insertAccount(db, { id: "acc_02", name: "B", token: "t2", created_at: 2 });
    gfRepo.setAccountRecoveryReason(db, "acc_01", "captcha", 2_000);
    gfRepo.setAccountRecoveryReason(db, "acc_02", "captcha", 1_000);

    const state = getVideosPageState(db);
    expect(state.bannerFlags.flowRecoveryAccounts).toEqual([
      { id: "acc_02", name: "B", required_at: 1_000 },
      { id: "acc_01", name: "A", required_at: 2_000 },
    ]);
  });
});
