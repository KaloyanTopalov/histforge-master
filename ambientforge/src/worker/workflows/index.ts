import type { Workflow } from '@/lib/repos/channels';
import { ambientWorkflow } from './ambient';
import { ambientVideoWorkflow } from './ambient-video';
import { rapCompilationWorkflow } from './rap-compilation';
import type { WorkflowDefinition } from './types';

export type {
  PreflightCheck,
  PreflightCheckResult,
  PreflightContext,
  WorkflowDefinition,
} from './types';

const REGISTRY: Record<Workflow, WorkflowDefinition> = {
  ambient: ambientWorkflow,
  'rap-compilation': rapCompilationWorkflow,
  'ambient-video': ambientVideoWorkflow,
};

export class UnknownWorkflowError extends Error {
  code = 'UNKNOWN_WORKFLOW';
  constructor(name: string) {
    super(`unknown workflow: ${name}`);
    this.name = 'UnknownWorkflowError';
  }
}

export function getWorkflow(name: string): WorkflowDefinition {
  const w = REGISTRY[name as Workflow];
  if (!w) throw new UnknownWorkflowError(name);
  return w;
}

export function listWorkflows(): WorkflowDefinition[] {
  return Object.values(REGISTRY);
}
