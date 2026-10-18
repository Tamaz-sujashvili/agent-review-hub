import type { ReactNode } from 'react';
import type { TaskState, TaskWaitReason } from '@quorum/protocol';

const STATE_TONE: Record<TaskState, string> = {
  QUEUED: 'muted',
  AUTHORING: 'info',
  AWAITING_REVIEWER: 'warn',
  IN_REVIEW: 'info',
  MERGE_QUEUED: 'info',
  MERGING: 'info',
  SYNCING: 'info',
  PAUSED: 'warn',
  ESCALATED: 'danger',
  MERGED: 'ok',
  CANCELLED: 'muted',
  FAILED: 'danger',
};

export const STATE_LABEL: Record<TaskState, string> = {
  QUEUED: 'Queued',
  AUTHORING: 'Authoring',
  AWAITING_REVIEWER: 'Waiting for reviewer',
  IN_REVIEW: 'In review',
  MERGE_QUEUED: 'Merge queued',
  MERGING: 'Merging',
  SYNCING: 'Syncing with main',
  PAUSED: 'Paused',
  ESCALATED: 'Needs decision',
  MERGED: 'Merged',
  CANCELLED: 'Cancelled',
  FAILED: 'Failed',
};

export function StateBadge({ state }: { state: TaskState }) {
  return <span className={`badge badge-${STATE_TONE[state]}`}>{STATE_LABEL[state]}</span>;
}

const WAIT_BLOCKERS: Record<TaskWaitReason['blockers'][number]['code'], { label: string; nextStep: string | null }> = {
  agent_offline: { label: 'offline', nextStep: 'Ask a teammate to reconnect or wait for them.' },
  agent_paused: { label: 'paused', nextStep: 'Resume the agent or choose another available agent.' },
  rate_limited: { label: 'rate-limited', nextStep: 'Wait for the usage limit to reset.' },
  session_capacity: { label: 'at session capacity', nextStep: 'Wait for a session to become free.' },
  session_start_backoff: { label: 'retrying after a session start failure', nextStep: 'The Leader will retry automatically.' },
  lending_disabled: { label: 'not accepting teammate work', nextStep: 'Ask a teammate to enable lending, or wait for another agent.' },
  owner_active: { label: 'owner is active', nextStep: 'Wait until the owner is idle or ask them to change their lending mode.' },
  budget_exhausted: { label: 'daily teammate-work budget is exhausted', nextStep: 'Wait for the budget to reset or adjust the agent budget.' },
  no_candidate_agent: { label: 'no other eligible agent is connected', nextStep: 'Invite another teammate or wait for one to connect.' },
  session_starting: { label: 'starting an agent session', nextStep: null },
  scheduler_pending: { label: 'checking agent availability', nextStep: null },
};

export function WaitReasonNote({ reason, compact = false }: { reason: TaskWaitReason | null | undefined; compact?: boolean }) {
  if (reason === null || reason === undefined) return null;
  const heading = reason.role === 'author' ? 'Waiting for an author' : 'Waiting for a reviewer';
  const blockers = reason.blockers.map(({ code, agentCount }) => {
    const label = WAIT_BLOCKERS[code].label;
    if (code === 'session_starting' || code === 'scheduler_pending' || code === 'no_candidate_agent') return label;
    return `${agentCount} agent${agentCount === 1 ? '' : 's'} ${label}`;
  });
  const nextStep = reason.blockers.map(({ code }) => WAIT_BLOCKERS[code].nextStep).find((step) => step !== null) ?? null;
  return (
    <div className={compact ? 'wait-reason wait-reason-compact' : 'note note-warn wait-reason'}>
      <strong>{heading}:</strong> {blockers.join('; ')}.
      {!compact && nextStep !== null && <div className="wait-next">Next: {nextStep}</div>}
    </div>
  );
}

export function Dot({ tone, title }: { tone: 'ok' | 'warn' | 'danger' | 'info' | 'muted'; title?: string }) {
  return <span className={`dot dot-${tone}`} title={title} />;
}

export function Card({ title, actions, children }: { title?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
      {(title !== undefined || actions !== undefined) && (
        <header className="card-header">
          <h3>{title}</h3>
          <div className="row">{actions}</div>
        </header>
      )}
      {children}
    </section>
  );
}

export function ErrorNote({ error }: { error: string | null | undefined }) {
  if (error === null || error === undefined) return null;
  return <div className="note note-danger">{error}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Bar({ value, max, tone = 'info' }: { value: number; max: number; tone?: string }) {
  const pct = max <= 0 ? 0 : Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className="bar">
      <div className={`bar-fill bar-${tone}`} style={{ width: `${pct}%` }} />
    </div>
  );
}
