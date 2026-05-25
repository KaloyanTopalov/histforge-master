import { ulid } from 'ulid';
import { getDb, type Db } from '../db';

export type ChannelSunoPrompt = {
  id: string;
  channelId: string;
  label: string;
  content: string;
  weight: number;
  active: boolean;
  createdAt: number;
  updatedAt: number;
};

export type ChannelSunoPromptInput = {
  channelId: string;
  label: string;
  content: string;
  weight?: number;
  active?: boolean;
};

export type ChannelSunoPromptPatch = Partial<{
  label: string;
  content: string;
  weight: number;
  active: boolean;
}>;

type Row = {
  id: string;
  channel_id: string;
  label: string;
  content: string;
  weight: number;
  active: number;
  created_at: number;
  updated_at: number;
};

const COLS = 'id, channel_id, label, content, weight, active, created_at, updated_at';

function fromRow(r: Row): ChannelSunoPrompt {
  return {
    id: r.id,
    channelId: r.channel_id,
    label: r.label,
    content: r.content,
    weight: r.weight,
    active: r.active === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function create(input: ChannelSunoPromptInput, db: Db = getDb()): ChannelSunoPrompt {
  const id = ulid();
  const now = Date.now();
  const weight = input.weight ?? 1.0;
  const active = (input.active ?? true) ? 1 : 0;
  db.prepare(
    `INSERT INTO channel_suno_prompts (${COLS})
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, input.channelId, input.label, input.content, weight, active, now, now);
  return {
    id,
    channelId: input.channelId,
    label: input.label,
    content: input.content,
    weight,
    active: active === 1,
    createdAt: now,
    updatedAt: now,
  };
}

export function get(id: string, db: Db = getDb()): ChannelSunoPrompt | null {
  const row = db
    .prepare(`SELECT ${COLS} FROM channel_suno_prompts WHERE id = ?`)
    .get(id) as Row | undefined;
  return row ? fromRow(row) : null;
}

export function listByChannel(
  channelId: string,
  opts: { activeOnly?: boolean } = {},
  db: Db = getDb(),
): ChannelSunoPrompt[] {
  const activeClause = opts.activeOnly ? 'AND active = 1' : '';
  const rows = db
    .prepare(
      `SELECT ${COLS} FROM channel_suno_prompts
       WHERE channel_id = ? ${activeClause}
       ORDER BY created_at ASC`,
    )
    .all(channelId) as Row[];
  return rows.map(fromRow);
}

export function patch(
  id: string,
  fields: ChannelSunoPromptPatch,
  db: Db = getDb(),
): ChannelSunoPrompt | null {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (fields.label !== undefined) {
    sets.push('label = ?');
    params.push(fields.label);
  }
  if (fields.content !== undefined) {
    sets.push('content = ?');
    params.push(fields.content);
  }
  if (fields.weight !== undefined) {
    sets.push('weight = ?');
    params.push(fields.weight);
  }
  if (fields.active !== undefined) {
    sets.push('active = ?');
    params.push(fields.active ? 1 : 0);
  }
  if (sets.length === 0) return get(id, db);
  sets.push('updated_at = ?');
  params.push(Date.now());
  params.push(id);
  db.prepare(
    `UPDATE channel_suno_prompts SET ${sets.join(', ')} WHERE id = ?`,
  ).run(...params);
  return get(id, db);
}

/**
 * Delete a prompt row, but first NULL-out any album OR track FKs that
 * referenced it so nothing dangles. The resolved-text snapshots on both
 * `albums.suno_prompt_resolved_text` and `tracks.suno_prompt_resolved_text`
 * (set at step 03 selection time) survive — that's the audit trail.
 */
export function remove(id: string, db: Db = getDb()): boolean {
  const tx = db.transaction(() => {
    db.prepare('UPDATE albums SET suno_prompt_id = NULL WHERE suno_prompt_id = ?').run(id);
    db.prepare('UPDATE tracks SET suno_prompt_id = NULL WHERE suno_prompt_id = ?').run(id);
    return db.prepare('DELETE FROM channel_suno_prompts WHERE id = ?').run(id).changes;
  });
  return tx() > 0;
}

export function countAlbumsUsing(promptId: string, db: Db = getDb()): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM albums WHERE suno_prompt_id = ?')
    .get(promptId) as { n: number } | undefined;
  return row?.n ?? 0;
}

export type ReplaceAllInput = {
  id?: string;
  label: string;
  content: string;
  weight?: number;
  active?: boolean;
};

/**
 * Replace the entire prompt collection for a channel with the given list.
 * Existing rows whose id appears in the input are PATCHED in place; rows whose
 * id is absent are DELETED (with the same FK-safe cascade as remove()); inputs
 * without an id are INSERTED. Used by POST/PATCH /api/channels.
 *
 * Note: channelId comes from the function parameter, not the input items, so
 * the API can accept channel-agnostic prompt arrays.
 */
export function replaceAllForChannel(
  channelId: string,
  inputs: ReplaceAllInput[],
  db: Db = getDb(),
): ChannelSunoPrompt[] {
  const tx = db.transaction(() => {
    const existing = listByChannel(channelId, {}, db);
    const inputIds = new Set(inputs.map((i) => i.id).filter((i): i is string => !!i));
    for (const e of existing) {
      if (!inputIds.has(e.id)) remove(e.id, db);
    }
    for (const inp of inputs) {
      if (inp.id) {
        patch(inp.id, {
          label: inp.label,
          content: inp.content,
          weight: inp.weight,
          active: inp.active,
        }, db);
      } else {
        create(
          {
            channelId,
            label: inp.label,
            content: inp.content,
            weight: inp.weight,
            active: inp.active,
          },
          db,
        );
      }
    }
    return listByChannel(channelId, {}, db);
  });
  return tx();
}
