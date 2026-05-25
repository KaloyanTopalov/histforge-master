import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  FlowError,
  __resetMockFlowState,
  __setMockNextFixture,
  __setMockFailNextPoll,
  makeMockFlowClient,
  makeBridgeFlowClient,
  type FlowClient,
} from '@/lib/flow/client';

let workDir: string;

beforeEach(() => {
  __resetMockFlowState();
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-client-test-'));
});

describe('flow/client mock', () => {
  it('submitPrompt returns deterministic mock-flow-NNNN ids', async () => {
    const client = makeMockFlowClient();
    const a = await client.submitPrompt('a square scene', '1:1');
    const b = await client.submitPrompt('another square', '1:1');
    expect(a).toBe('mock-flow-0001');
    expect(b).toBe('mock-flow-0002');
  });

  it('poll returns ready by default and copies the matching fixture', async () => {
    const client = makeMockFlowClient();
    const taskId = await client.submitPrompt('forest at dusk', '1:1');
    expect(await client.poll(taskId)).toBe('ready');
    const dest = path.join(workDir, 'cover.png');
    await client.download(taskId, dest);
    const stat = fs.statSync(dest);
    expect(stat.size).toBeGreaterThan(0);
  });

  it('1:1 prompts default to fixture-square; 16:9 prompts default to fixture-wide', async () => {
    const client = makeMockFlowClient();
    const sq = await client.submitPrompt('square', '1:1');
    const wd = await client.submitPrompt('wide', '16:9');
    const sqDest = path.join(workDir, 'sq.png');
    const wdDest = path.join(workDir, 'wd.png');
    await client.download(sq, sqDest);
    await client.download(wd, wdDest);
    const sqRef = fs.readFileSync(
      path.join(process.cwd(), 'tests', 'fixtures', 'flow', 'fixture-square.png'),
    );
    const wdRef = fs.readFileSync(
      path.join(process.cwd(), 'tests', 'fixtures', 'flow', 'fixture-wide.png'),
    );
    expect(fs.readFileSync(sqDest).equals(sqRef)).toBe(true);
    expect(fs.readFileSync(wdDest).equals(wdRef)).toBe(true);
  });

  it('__setMockNextFixture forces the chosen fixture once', async () => {
    const client = makeMockFlowClient();
    __setMockNextFixture('fixture-wide.png');
    const t1 = await client.submitPrompt('forced wide', '1:1');
    const t2 = await client.submitPrompt('back to default', '1:1');
    const a = path.join(workDir, 'a.png');
    const b = path.join(workDir, 'b.png');
    await client.download(t1, a);
    await client.download(t2, b);
    const wide = fs.readFileSync(
      path.join(process.cwd(), 'tests', 'fixtures', 'flow', 'fixture-wide.png'),
    );
    const square = fs.readFileSync(
      path.join(process.cwd(), 'tests', 'fixtures', 'flow', 'fixture-square.png'),
    );
    expect(fs.readFileSync(a).equals(wide)).toBe(true);
    expect(fs.readFileSync(b).equals(square)).toBe(true);
  });

  it('__setMockFailNextPoll causes the next poll to return failed once', async () => {
    const client = makeMockFlowClient();
    const t = await client.submitPrompt('content-policy probe', '1:1');
    __setMockFailNextPoll(true);
    expect(await client.poll(t)).toBe('failed');
    // The flag is consumed after one call; subsequent polls return 'ready'.
    expect(await client.poll(t)).toBe('ready');
  });
});

describe('flow/client bridge error mapping', () => {
  it('maps fetch ECONNREFUSED to retriable FLOW_BRIDGE_UNREACHABLE', async () => {
    const fetchImpl: FlowClient extends infer _ ? typeof fetch : never = (async () => {
      const err = new Error('connect ECONNREFUSED 127.0.0.1:7343') as Error & { code?: string };
      err.code = 'ECONNREFUSED';
      throw err;
    }) as unknown as typeof fetch;
    const client = makeBridgeFlowClient({ fetchImpl });
    let caught: unknown;
    try {
      await client.submitPrompt('x', '1:1');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FlowError);
    expect((caught as FlowError).code).toBe('FLOW_BRIDGE_UNREACHABLE');
    expect((caught as FlowError).retriable).toBe(true);
  });

  it('maps AbortError to FLOW_BRIDGE_TIMEOUT', async () => {
    const fetchImpl: typeof fetch = (async () => {
      const err = new Error('aborted') as Error & { name?: string };
      err.name = 'AbortError';
      throw err;
    }) as unknown as typeof fetch;
    const client = makeBridgeFlowClient({ fetchImpl });
    let caught: unknown;
    try {
      await client.submitPrompt('x', '1:1');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FlowError);
    expect((caught as FlowError).code).toBe('FLOW_BRIDGE_TIMEOUT');
    expect((caught as FlowError).retriable).toBe(true);
  });

  it('throws FlowError when 5xx', async () => {
    const fetchImpl: typeof fetch = (async () => {
      return new Response('internal', { status: 502 });
    }) as unknown as typeof fetch;
    const client = makeBridgeFlowClient({ fetchImpl });
    let caught: unknown;
    try {
      await client.submitPrompt('x', '1:1');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FlowError);
    expect((caught as FlowError).code).toBe('FLOW_BRIDGE_ERROR');
    expect((caught as FlowError).retriable).toBe(true);
  });

  it('maps poll() with FLOW_PROMPT_REJECTED-shaped failed status', async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = (async () => {
      calls++;
      if (calls === 1) {
        return new Response(JSON.stringify({ taskId: 't1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({ status: 'failed', error: 'rejected by content policy' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
    const client = makeBridgeFlowClient({ fetchImpl });
    const taskId = await client.submitPrompt('test', '1:1');
    let caught: unknown;
    try {
      await client.poll(taskId);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FlowError);
    expect((caught as FlowError).code).toBe('FLOW_PROMPT_REJECTED');
    expect((caught as FlowError).retriable).toBe(true);
  });
});
