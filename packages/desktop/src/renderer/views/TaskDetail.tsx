import { useState, type ReactNode } from 'react';
import type { ApiRouteName, MessageView, TaskDetail as Detail, TaskEventView } from '@quorum/protocol';
import type { AppState } from '../../shared/ipc';
import { call, timeAgo, useLive } from '../bridge';
import { Card, Empty, ErrorNote, STATE_LABEL, StateBadge, WaitReasonNote } from '../components/common';
import { DiffView, type DiffRange } from '../components/DiffView';

type Tab = 'timeline' | 'issues' | 'diff' | 'description';

export function TaskDetail({ id, state, onBack, initialTab }: { id: number; state: AppState; onBack: () => void; initialTab?: string | null }) {
  const detail = useLive(() => call('getTask', { id }), [id], { events: ['task.updated', 'task.event'], pollMs: 5000 });
  const [tab, setTab] = useState<Tab>((['timeline', 'issues', 'diff', 'description'] as const).find((t) => t === initialTab) ?? 'timeline');
  const [error, setError] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);

  const d = detail.data;
  if (d === undefined) {
    return (
      <div className="stack">
        <button className="link" onClick={onBack}>
          ← Tasks
        </button>
        <ErrorNote error={detail.error} />
        {detail.error === null && <Empty>Loading…</Empty>}
      </div>
    );
  }
  const t = d.task;
  const canAct = state.isAdmin || t.requesterOwner === state.ownerName;
  const terminal = ['MERGED', 'CANCELLED', 'FAILED'].includes(t.state);

  const act = async (route: ApiRouteName, body?: unknown, confirmText?: string) => {
    if (confirmText !== undefined && !window.confirm(confirmText)) return;
    setBusy(true);
    setError(null);
    try {
      await call(route, { id: t.id, body: body ?? {} });
      setComment('');
      detail.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const reviewers = [...new Set(d.conversations.map((c) => c.reviewerAgentId))];
  const blockedQuestion = t.escalationReason?.startsWith('author_blocked:') ? t.escalationReason.slice('author_blocked:'.length).trim() : null;

  return (
    <div className="stack">
      <button className="link" onClick={onBack}>
        ← Tasks
      </button>
      <div className="row">
        <h2 className="grow">
          <span className="muted">#{t.id}</span> {t.title}
        </h2>
        <StateBadge state={t.state} />
      </div>
      <div className="meta">
        <span>Requested by {t.requesterOwner}</span>
        <span>Author {t.authorAgentId ?? '—'}</span>
        <span>Reviewer {reviewers.join(', ') || '—'}</span>
        <span>Round {t.reviewRound}</span>
        {t.branch !== null && <code>{t.branch}</code>}
        {t.mergedCommit !== null && <code>merged {t.mergedCommit.slice(0, 7)}</code>}
        <span className="muted">updated {timeAgo(t.updatedAt)}</span>
      </div>

      <WaitReasonNote reason={t.waitReason} />

      {t.state === 'ESCALATED' && (
        <div className="note note-danger">
          {blockedQuestion !== null ? (
            <>
              <strong>The author agent needs a decision:</strong> {blockedQuestion}
            </>
          ) : (
            <>
              <strong>Needs a human decision:</strong> {t.escalationReason}
            </>
          )}
        </div>
      )}
      {t.state === 'PAUSED' && (
        <div className="note note-warn">
          Paused ({t.pauseReason}) while {STATE_LABEL[t.pausedFromState ?? 'QUEUED'].toLowerCase()}.
        </div>
      )}

      {canAct && !terminal && (
        <Card title="Actions">
          <div className="row wrap">
            {['ESCALATED', 'IN_REVIEW', 'AWAITING_REVIEWER'].includes(t.state) && t.headCommit !== null && (
              <button className="primary" disabled={busy} onClick={() => void act('approveTask', {}, 'Approve and merge this task without further review?')}>
                Approve & merge
              </button>
            )}
            {t.state === 'IN_REVIEW' && (
              <button disabled={busy} onClick={() => void act('reassignReviewer')}>
                Reassign reviewer
              </button>
            )}
            {['QUEUED', 'AUTHORING', 'AWAITING_REVIEWER', 'IN_REVIEW', 'SYNCING', 'ESCALATED'].includes(t.state) && (
              <button disabled={busy} onClick={() => void act('pauseTask')}>
                Pause
              </button>
            )}
            {t.state === 'PAUSED' && t.pauseReason === 'human' && (
              <button disabled={busy} onClick={() => void act('resumeTask')}>
                Resume
              </button>
            )}
            <span className="grow" />
            {/* The Leader refuses to cancel during a merge (409). */}
            <button
              className="danger"
              disabled={busy || t.state === 'MERGING'}
              title={t.state === 'MERGING' ? 'The task is being merged; wait for it to finish.' : undefined}
              onClick={() => void act('cancelTask', {}, 'Cancel this task? Its branch will be deleted.')}
            >
              Cancel task
            </button>
          </div>
          {['ESCALATED', 'IN_REVIEW', 'AWAITING_REVIEWER'].includes(t.state) && (
            <div className="stack-sm">
              <textarea
                rows={3}
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder={blockedQuestion !== null ? 'Your answer for the author agent…' : 'What should the author change? (sent as a blocking issue)'}
              />
              <div className="row">
                <button disabled={busy || comment.trim() === ''} onClick={() => void act('sendBackTask', { comment })}>
                  {blockedQuestion !== null ? 'Answer and continue' : 'Send back to author'}
                </button>
              </div>
            </div>
          )}
          <ErrorNote error={error} />
        </Card>
      )}

      <div className="tabs">
        {(['timeline', 'issues', 'diff', 'description'] as Tab[]).map((x) => (
          <button key={x} className={tab === x ? 'tab active' : 'tab'} onClick={() => setTab(x)}>
            {x === 'issues' ? `Issues (${d.issues.length})` : x[0]!.toUpperCase() + x.slice(1)}
          </button>
        ))}
      </div>
      {tab === 'timeline' && <Timeline detail={d} />}
      {tab === 'issues' && <Issues detail={d} />}
      {tab === 'diff' && <DiffView taskId={t.id} ranges={diffRanges(d)} />}
      {tab === 'description' && (
        <Card>
          <pre className="prewrap">{t.description}</pre>
          {t.lastTestOutput !== null && (
            <>
              <h4>Last test output</h4>
              <pre className="log">{t.lastTestOutput}</pre>
            </>
          )}
        </Card>
      )}
    </div>
  );
}

function diffRanges(d: Detail): DiffRange[] {
  const ranges: DiffRange[] = [];
  const t = d.task;
  if (t.baseCommit !== null && t.headCommit !== null) ranges.push({ label: 'Whole change (latest)', from: t.baseCommit, to: t.headCommit });
  for (const m of d.messages) {
    if (m.direction !== 'to_node') continue;
    const p = m.payload as { round?: number; baseCommit?: string; headCommit?: string; fromCommit?: string };
    if (m.type === 'review.start' && p.baseCommit && p.headCommit) ranges.push({ label: `Round ${p.round}: reviewed change`, from: p.baseCommit, to: p.headCommit });
    if (m.type === 'review.rereview' && p.fromCommit && p.headCommit) ranges.push({ label: `Round ${p.round}: changes since last review`, from: p.fromCommit, to: p.headCommit });
  }
  return ranges;
}

type Entry = { at: number; key: string; node: ReactNode };

function Timeline({ detail }: { detail: Detail }) {
  const entries: Entry[] = [
    ...detail.events.map((e) => ({ at: e.at, key: `e${e.id}`, node: <EventLine e={e} /> })),
    ...detail.messages.flatMap((m) => {
      const node = describeMessage(m);
      return node === null ? [] : [{ at: m.createdAt, key: `m${m.id}`, node }];
    }),
  ].sort((a, b) => a.at - b.at);
  if (entries.length === 0) return <Empty>Nothing yet.</Empty>;
  return (
    <ol className="timeline">
      {entries.map((x) => (
        <li key={x.key}>
          <time>{new Date(x.at).toLocaleTimeString()}</time>
          <div>{x.node}</div>
        </li>
      ))}
    </ol>
  );
}

function EventLine({ e }: { e: TaskEventView }) {
  if (e.reason === 'overlap_warning') {
    const data = e.data as { otherTaskId?: number; files?: string[] };
    return (
      <span className="warn-text">
        Touches the same files as task #{data.otherTaskId}: {(data.files ?? []).join(', ')}
      </span>
    );
  }
  return (
    <span>
      <strong>{e.fromState === null ? 'Created' : `${STATE_LABEL[e.fromState]} → ${STATE_LABEL[e.toState]}`}</strong>{' '}
      <span className="muted">
        {e.reason.replace(/_/g, ' ')} · {e.actor}
      </span>
    </span>
  );
}

/** One timeline line per meaningful message; plumbing (checkpoints, session opens, acks) is omitted. */
function describeMessage(m: MessageView): ReactNode | null {
  const p = (m.payload ?? {}) as Record<string, unknown>;
  const who = m.agentId;
  switch (m.type) {
    case 'author.start':
      return <span>Leader asked <b>{who}</b> to write the task{p.continueExisting ? ' (continuing an existing branch)' : ''}</span>;
    case 'author.revise':
      return <span>Leader sent <b>{who}</b> {Array.isArray(p.openIssues) ? p.openIssues.length : 0} issue(s) to fix{p.testFailure ? ' and a test failure' : ''}</span>;
    case 'author.sync':
      return <span>Leader asked <b>{who}</b> to merge the latest main</span>;
    case 'review.start':
      return <span>Leader asked <b>{who}</b> to review (round {String(p.round)})</span>;
    case 'review.rereview':
      return <span>Leader asked <b>{who}</b> to re-review the changes (round {String(p.round)})</span>;
    case 'author.submitted': {
      const tests = p.tests as { passed?: boolean } | undefined;
      return (
        <span>
          <b>{who}</b> submitted {String((p.headCommit as string | undefined)?.slice(0, 7) ?? '')} — tests {tests?.passed ? 'passed' : 'failed'}
          <Quote text={p.summary} />
        </span>
      );
    }
    case 'review.completed': {
      const out = p.output as { verdict?: string; summary?: string; newIssues?: unknown[] } | undefined;
      return (
        <span>
          <b>{who}</b> reviewed: {out?.verdict === 'approve' ? 'approve' : `changes requested (${out?.newIssues?.length ?? 0} new issue(s))`}
          <Quote text={out?.summary} />
        </span>
      );
    }
    case 'author.synced':
      return <span><b>{who}</b> merged main {p.hadConflicts ? 'and resolved conflicts' : 'cleanly'}</span>;
    case 'turn.failed':
      if (p.code === 'CANCELLED') return <span className="muted"><b>{who}</b> stopped its current turn (cancelled)</span>;
      return <span className="warn-text"><b>{who}</b> turn failed: {String(p.code)} — {String(p.message)}</span>;
    case 'session.compacted':
      return <span className="muted"><b>{who}</b> compacted its session to free context</span>;
    default:
      return null;
  }
}

function Quote({ text }: { text: unknown }) {
  if (typeof text !== 'string' || text === '') return null;
  return <blockquote>{text}</blockquote>;
}

function Issues({ detail }: { detail: Detail }) {
  if (detail.issues.length === 0) return <Empty>No issues raised.</Empty>;
  return (
    <div className="stack-sm">
      {detail.issues.map((i) => (
        <div key={i.id} className={`issue issue-${i.status}`}>
          <div className="row">
            <strong>{i.code}</strong>
            <span className={`badge badge-${i.severity === 'blocking' ? 'danger' : 'muted'}`}>{i.severity}</span>
            <span className="muted">{i.source}</span>
            {i.file !== null && (
              <code>
                {i.file}
                {i.line !== null ? `:${i.line}` : ''}
              </code>
            )}
            <span className="grow" />
            <span className="badge">{i.status.replace(/_/g, ' ')}</span>
          </div>
          <pre className="prewrap">{i.comment}</pre>
          {i.authorResponse !== null && (
            <div className="muted small">
              Author: <b>{i.authorResponse}</b>
              {i.authorNote ? ` — ${i.authorNote}` : ''}
              {i.disputeCount > 0 ? ` · disputed ${i.disputeCount}×` : ''}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
