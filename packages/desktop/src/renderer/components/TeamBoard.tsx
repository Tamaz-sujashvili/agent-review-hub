import type { AgentView, QueueEntryView, TeamActivityView } from '@quorum/protocol';
import { duration, formatTokens, timeAgo } from '../bridge';
import { Card, Dot, Empty } from './common';

// Dashboard answers at a glance: who works on what, who waits for whom, and what the scheduler picks next.

type Tone = 'ok' | 'warn' | 'danger' | 'info' | 'muted';

const PRIORITY: Record<number, { label: string; tone: Tone }> = {
  0: { label: 'Low', tone: 'muted' },
  1: { label: 'Normal', tone: 'info' },
  2: { label: 'High', tone: 'warn' },
  3: { label: 'Urgent', tone: 'danger' },
};

const NEEDS: Record<QueueEntryView['needs'], string> = { author: 'Author', reviewer: 'Reviewer', merge: 'Merge', human: 'Human' };

function TaskLink({ id, title, onOpen }: { id: number; title: string | null; onOpen: (id: number) => void }) {
  return (
    // An inline anchor (not a button) so long titles wrap with the surrounding text.
    <a
      href="#"
      className="task-ref"
      onClick={(e) => {
        e.preventDefault();
        onOpen(id);
      }}
    >
      <span className="mono">#{id}</span> {title}
    </a>
  );
}

export function TeamStats({ activities, queue }: { activities: TeamActivityView[]; queue: QueueEntryView[] }) {
  const stats: { label: string; value: number; tone: Tone }[] = [
    { label: 'Working', value: activities.filter((a) => a.activityState === 'working').length, tone: 'ok' },
    { label: 'Waiting', value: activities.filter((a) => a.activityState === 'waiting').length, tone: 'info' },
    { label: 'Queued tasks', value: queue.filter((q) => q.position !== null).length, tone: 'warn' },
    { label: 'Needs a human', value: queue.filter((q) => q.needs === 'human').length, tone: 'danger' },
  ];
  return (
    <div className="stats">
      {stats.map((s) => (
        <div className="stat" key={s.label}>
          <div className="stat-label">
            <Dot tone={s.tone} />
            {s.label}
          </div>
          <div className="stat-value">{s.value}</div>
        </div>
      ))}
    </div>
  );
}

interface AgentTile {
  agentId: string;
  ownerName: string;
  status: AgentView['status'];
  paused: boolean;
  lendMode: AgentView['lendMode'] | null;
  usedSessions: number | null;
  maxSessions: number | null;
  rateLimitedUntil: number | null;
  lastHeartbeatAt: number | null;
  budgetRemaining: number | null;
  rows: TeamActivityView[];
}

/** One tile per agent: merges listAgents (capacity, lending) with team activity (what each session does). */
function agentTiles(agents: AgentView[] | undefined, activities: TeamActivityView[]): AgentTile[] {
  const tiles = new Map<string, AgentTile>();
  for (const a of agents ?? []) {
    tiles.set(a.id, {
      agentId: a.id, ownerName: a.ownerName, status: a.status, paused: a.paused, lendMode: a.lendMode,
      usedSessions: a.lockedSessions, maxSessions: a.maxSessions,
      rateLimitedUntil: a.rateLimitedUntil !== null && a.rateLimitedUntil > Date.now() ? a.rateLimitedUntil : null,
      lastHeartbeatAt: a.lastHeartbeatAt, budgetRemaining: a.budgetRemaining, rows: [],
    });
  }
  for (const row of activities) {
    let tile = tiles.get(row.agentId);
    if (tile === undefined) {
      tile = {
        agentId: row.agentId, ownerName: row.ownerName, status: row.agentStatus, paused: row.activityState === 'paused', lendMode: null,
        usedSessions: null, maxSessions: null, rateLimitedUntil: row.rateLimitedUntil ?? null, lastHeartbeatAt: row.lastHeartbeatAt,
        budgetRemaining: null, rows: [],
      };
      tiles.set(row.agentId, tile);
    }
    if (row.role !== 'idle' || row.sessionState === 'opening') tile.rows.push(row);
  }
  return [...tiles.values()].sort((a, b) => a.ownerName.localeCompare(b.ownerName) || a.agentId.localeCompare(b.agentId));
}

/**
 * What an idle agent can do for teammates. It never promises a pickup: when_idle eligibility depends on an idle
 * threshold the Leader does not report, and each task's cost estimate decides whether the remaining budget suffices.
 */
function idleLabel(tile: AgentTile): string {
  if (tile.lendMode === 'never') return 'Idle · own work only';
  if (tile.maxSessions !== null && tile.usedSessions !== null && tile.usedSessions >= tile.maxSessions) return 'Idle · no free session';
  if (tile.budgetRemaining !== null && tile.budgetRemaining <= 0) return 'Idle · lending budget used up';
  if (tile.lendMode === 'when_idle') return 'Idle · lends when its owner is away';
  if (tile.lendMode === 'always') return tile.budgetRemaining === null ? 'Idle · lends to teammates' : `Idle · lends to teammates (${formatTokens(tile.budgetRemaining)} budget left)`;
  return 'Idle';
}

function tileTone(tile: AgentTile): Tone {
  if (tile.status !== 'online') return 'muted';
  if (tile.rateLimitedUntil !== null || tile.paused) return 'warn';
  if (tile.rows.some((r) => r.activityState === 'working')) return 'ok';
  if (tile.rows.some((r) => r.activityState === 'waiting')) return 'info';
  return 'ok';
}

function SessionLine({ row, onOpen }: { row: TeamActivityView; onOpen: (id: number) => void }) {
  if (row.role === 'idle') return <div className="agent-line muted">Starting a session…</div>;
  const verb = row.role === 'author' ? 'Writing' : row.role === 'reviewer' ? 'Reviewing' : 'Answering';
  const waiting = row.activityState === 'waiting' || row.activityState === 'paused';
  const partner = row.role === 'reviewer' && row.pairedOwnerName !== null ? `for ${row.pairedOwnerName}` : null;
  return (
    <div className="agent-line">
      <span className="muted">{verb} </span>
      {row.taskId !== null ? <TaskLink id={row.taskId} title={row.taskTitle} onOpen={onOpen} /> : <span>{row.taskTitle ?? 'a question'}</span>}
      {partner !== null && <span className="muted"> {partner}</span>}
      {waiting && <span className="info-text"> · {waitText(row)}</span>}
    </div>
  );
}

function waitText(row: TeamActivityView): string {
  if (row.waitingOn === 'agent' && row.waitingForName !== null) {
    return row.role === 'author' ? `waiting for ${row.waitingForName}'s review` : `waiting for ${row.waitingForName}'s fixes`;
  }
  return (row.waitingReason ?? 'waiting').toLowerCase();
}

export function AgentsNow({ agents, activities, me, onOpenTask }: {
  agents: AgentView[] | undefined;
  activities: TeamActivityView[];
  me: string | null;
  onOpenTask: (id: number) => void;
}) {
  const tiles = agentTiles(agents, activities);
  const online = tiles.filter((t) => t.status === 'online').length;
  return (
    <Card title="Agents now" actions={<span className="hint">{tiles.length} agents · {online} online</span>}>
      {tiles.length === 0 ? <Empty>No team agents yet.</Empty> : (
        <div className="agent-grid">
          {tiles.map((tile) => (
            <div className={tile.status === 'online' ? 'agent-tile' : 'agent-tile agent-offline'} key={tile.agentId}>
              <div className="agent-head">
                <Dot tone={tileTone(tile)} />
                <strong>{tile.ownerName}</strong>
                {tile.agentId === me && <span className="tag">you</span>}
                <span className="grow" />
                {tile.maxSessions !== null && <span className="mono muted small">{tile.usedSessions}/{tile.maxSessions} busy</span>}
              </div>
              <div className="agent-lines">
                {tile.status !== 'online' ? (
                  <div className="muted">Offline · last seen {timeAgo(tile.lastHeartbeatAt)}</div>
                ) : (
                  <>
                    {tile.rateLimitedUntil !== null && <div className="warn-text">Rate-limited · resets in {duration(Date.now(), tile.rateLimitedUntil)}</div>}
                    {tile.paused && <div className="warn-text">Paused by its owner</div>}
                    {tile.rows.map((row) => <SessionLine key={row.key} row={row} onOpen={onOpenTask} />)}
                    {tile.rows.length === 0 && tile.rateLimitedUntil === null && !tile.paused && (
                      <div className="muted">{idleLabel(tile)}</div>
                    )}
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

type Party = { kind: 'agent' | 'task' | 'human' | 'free' | 'limit'; label: string };

interface Wait {
  key: string;
  from: Party;
  to: Party;
  taskId: number | null;
  reason: string;
  /** When the wait started, if known; rate-limit waits only know when they end. */
  since: number | null;
  until: number | null;
}

const PARTY: Record<Party['kind'], { tag: string; tone: Tone | 'accent' }> = {
  agent: { tag: 'AGENT', tone: 'info' },
  task: { tag: 'TASK', tone: 'accent' },
  human: { tag: 'HUMAN', tone: 'danger' },
  free: { tag: 'QUEUE', tone: 'warn' },
  limit: { tag: 'LIMIT', tone: 'warn' },
};

/** Agent→agent and agent→rate-limit waits come from activity; task→human/agent waits come from the queue. */
function waitsFor(activities: TeamActivityView[], queue: QueueEntryView[]): Wait[] {
  const waits: Wait[] = [];
  for (const row of activities) {
    if (row.activityState !== 'waiting') continue;
    if (row.waitingOn === 'agent' && row.waitingForName !== null && row.taskId !== null) {
      const other = row.role === 'author' ? 'reviewer' : 'author';
      waits.push({
        key: row.key,
        from: { kind: 'agent', label: `${row.ownerName}'s agent (${row.role} of #${row.taskId})` },
        to: { kind: 'agent', label: `${row.waitingForName}'s agent (${other})` },
        taskId: row.taskId,
        reason: row.waitingReason ?? 'Waiting',
        since: row.stateChangedAt,
        until: null,
      });
    } else if (row.waitingOn === 'rate_limit' && row.rateLimitedUntil !== null) {
      waits.push({
        key: row.key,
        from: { kind: 'agent', label: `${row.ownerName}'s agent` },
        to: { kind: 'limit', label: 'rate-limit reset' },
        taskId: null,
        reason: `Resets at ${new Date(row.rateLimitedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
        // No rate-limit start time is stored (stateChangedAt follows heartbeats here), so show the time left.
        since: null,
        until: row.rateLimitedUntil,
      });
    }
  }
  for (const entry of queue) {
    if (entry.waitingOn === 'scheduler' || entry.waitingOn === 'merge') continue;
    // The task's author can never review it, so it is not who the task waits on.
    const able = entry.candidates.filter((c) => c.blocker !== `wrote #${entry.taskId}`);
    const to: Party = entry.needs === 'human'
      ? { kind: 'human', label: `a human (${entry.requesterOwner})` }
      : entry.waitingOn === 'rate_limit'
        ? { kind: 'limit', label: 'rate-limit reset' }
        : able.length === 1 && able[0] !== undefined
          ? { kind: 'agent', label: `${able[0].ownerName}'s agent` }
          : { kind: 'free', label: `a free ${entry.needs}` };
    waits.push({ key: `task:${entry.taskId}`, from: { kind: 'task', label: `Task #${entry.taskId}` }, to, taskId: entry.taskId, reason: entry.reason, since: entry.waitingSince, until: null });
  }
  return waits.sort((a, b) => (a.since ?? Number.MAX_SAFE_INTEGER) - (b.since ?? Number.MAX_SAFE_INTEGER));
}

function Chip({ party }: { party: Party }) {
  const meta = PARTY[party.kind];
  return (
    <span className={`chip chip-${meta.tone}`}>
      <span className="chip-tag">{meta.tag}</span>
      {party.label}
    </span>
  );
}

export function WaitsFor({ activities, queue, onOpenTask }: { activities: TeamActivityView[]; queue: QueueEntryView[]; onOpenTask: (id: number) => void }) {
  const waits = waitsFor(activities, queue);
  const now = Date.now();
  return (
    <Card title="Who is waiting for whom" actions={<span className="hint">{waits.length === 1 ? '1 wait' : `${waits.length} waits`}</span>}>
      {waits.length === 0 ? <Empty>Nobody is waiting.</Empty> : (
        <div className="wait-list">
          {waits.map((w) => (
            <div className="wait-row" key={w.key}>
              <Chip party={w.from} />
              <span className="muted small">waits on</span>
              <Chip party={w.to} />
              {w.taskId !== null && w.from.kind !== 'task' ? (
                <button className="link wait-reason" onClick={() => onOpenTask(w.taskId!)}>{w.reason}</button>
              ) : (
                <span className="wait-reason muted" title={w.reason}>{w.reason}</span>
              )}
              <span className="mono muted small">{w.since !== null ? duration(w.since, now) : w.until !== null ? `${duration(now, w.until)} left` : ''}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

export function QueueCard({ queue, onOpenTask }: { queue: QueueEntryView[]; onOpenTask: (id: number) => void }) {
  const now = Date.now();
  // The scheduler tries every task each pass, so "next" is the first one it can act on, not simply the first in line.
  const next = queue.find((q) => q.position !== null && q.waitingOn === 'scheduler');
  return (
    <Card title="Queue" actions={<span className="hint">In the order the scheduler tries them</span>}>
      {queue.length === 0 ? <Empty>The queue is empty.</Empty> : (
        <table className="table queue-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Task</th>
              <th>Needs</th>
              <th>Requested by</th>
              <th>Priority</th>
              <th>Waiting</th>
              <th>Blocked by</th>
            </tr>
          </thead>
          <tbody>
            {queue.map((q) => {
              const priority = PRIORITY[q.priority] ?? PRIORITY[1]!;
              const blockers = q.candidates.filter((c) => c.blocker !== null).map((c) => `${c.ownerName}: ${c.blocker}`).join('\n');
              const tone: Tone = q.waitingOn === 'scheduler' ? 'ok' : q.waitingOn === 'human' ? 'danger' : q.waitingOn === 'merge' ? 'info' : 'warn';
              return (
                <tr key={q.taskId} className={q === next ? 'queue-next' : undefined}>
                  <td className="mono">{q.position ?? '—'}</td>
                  <td>
                    <TaskLink id={q.taskId} title={q.title} onOpen={onOpenTask} />
                    {q === next && <span className="badge badge-info queue-badge">Next</span>}
                  </td>
                  <td><span className={q.needs === 'human' ? 'badge badge-danger' : 'badge badge-muted'}>{NEEDS[q.needs]}</span></td>
                  <td>{q.requesterOwner}</td>
                  <td><span className={`badge badge-${priority.tone}`}>{priority.label}</span></td>
                  <td className="mono muted">{duration(q.waitingSince, now)}</td>
                  <td title={blockers === '' ? undefined : blockers}>
                    <span className="row queue-reason">
                      <Dot tone={tone} />
                      <span className={tone === 'ok' ? 'ok-text' : undefined}>{q.reason}</span>
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Card>
  );
}
