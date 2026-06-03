export type AutopilotProposalMode = 'freshness' | 'targeted' | 'per_source' | 'legacy';

export interface AutopilotJobProposal {
  event: 'proposed';
  mode: AutopilotProposalMode;
  job: string;
  params: Record<string, unknown>;
  submit_options: Record<string, unknown>;
  step?: string;
  score?: number;
  plan_size?: number;
  protected?: boolean;
  source_id?: string;
  age_ms?: number;
  slot?: string;
}

export interface BuildAutopilotJobProposalInput {
  mode: AutopilotProposalMode;
  job: string;
  params: Record<string, unknown>;
  submitOptions: Record<string, unknown>;
  metadata?: Partial<Omit<AutopilotJobProposal, 'event' | 'mode' | 'job' | 'params' | 'submit_options'>>;
}

export function isAutopilotProposeOnly(args: string[]): boolean {
  return args.includes('--propose-only') || args.includes('--observe');
}

export function buildAutopilotJobProposal(input: BuildAutopilotJobProposalInput): AutopilotJobProposal {
  const proposal: AutopilotJobProposal = {
    event: 'proposed',
    mode: input.mode,
    job: input.job,
    params: input.params,
    submit_options: input.submitOptions,
  };
  for (const [key, value] of Object.entries(input.metadata ?? {})) {
    if (value !== undefined) {
      (proposal as unknown as Record<string, unknown>)[key] = value;
    }
  }
  return proposal;
}

type QueueAddResult = { id: number };

type QueueLike = {
  add: (
    name: string,
    data: Record<string, unknown>,
    opts: Record<string, unknown>,
    protectedSubmitContext?: any,
  ) => Promise<QueueAddResult>;
};

export type AutopilotSubmitOrProposeResult =
  | { kind: 'proposed'; proposal: AutopilotJobProposal }
  | { kind: 'submitted'; job_id: number; job: QueueAddResult };

export async function submitOrProposeAutopilotJob(input: {
  queue: QueueLike;
  proposeOnly: boolean;
  job: string;
  params: Record<string, unknown>;
  submitOptions: Record<string, unknown>;
  proposal: AutopilotJobProposal;
  protectedSubmitContext?: unknown;
}): Promise<AutopilotSubmitOrProposeResult> {
  if (input.proposeOnly) {
    return { kind: 'proposed', proposal: input.proposal };
  }

  const job = input.protectedSubmitContext === undefined
    ? await input.queue.add(input.job, input.params, input.submitOptions)
    : await input.queue.add(input.job, input.params, input.submitOptions, input.protectedSubmitContext);
  return { kind: 'submitted', job_id: job.id, job };
}
