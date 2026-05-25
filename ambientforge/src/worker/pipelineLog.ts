import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

export type LogFn = (stage: string, msg: string) => void;

const LOG_DIR = path.join(process.cwd(), 'data');
const LOG_PATH = path.join(LOG_DIR, 'pipeline.log');

let dirEnsured = false;
function ensureDir(): void {
  if (dirEnsured) return;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    dirEnsured = true;
  } catch (err) {
    console.warn('[pipelineLog] mkdir failed:', err);
  }
}

export function pipelineLogPath(): string {
  return LOG_PATH;
}

export function makePipelineLog(albumId: string): LogFn {
  return (stage, msg) => {
    const ts = new Date().toISOString();
    const perf = performance.now().toFixed(3);
    const line = `[pipeline] ${ts} t=${perf}ms album=${albumId} ${stage} ${msg}`;
    console.log(line);
    ensureDir();
    try {
      fs.appendFileSync(LOG_PATH, line + '\n');
    } catch (err) {
      console.warn('[pipelineLog] append failed:', err);
    }
  };
}
