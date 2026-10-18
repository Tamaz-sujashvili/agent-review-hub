import { useState } from 'react';
import type { QueueEntryView, TeamActivityView } from '@quorum/protocol';
import type { AppState } from '../../shared/ipc';
import { bridge, call, formatTokens, timeAgo, useLive } from '../bridge';
import { Bar, Card, Dot, Empty, ErrorNote } from '../components/common';
import { AgentsNow, QueueCard, TeamStats, WaitsFor } from '../components/TeamBoard';

export function Dashboard({ state, onOpenTask }: { state: AppState; onOpenTask: (id: number) => void }) {
  const agents = useLive(() => call('listAgents'), [], { events: ['agent.updated', 'session.updated'], pollMs: 10_000 });
  const tasks = useLive(() => call('listTasks', { query: { mine: 'true' } }), [], { events: ['task.updated'] });
  const activity = useLive(() => call('teamActivity'), [], { events: ['team.activity.updated'], pollMs: 5000 });
  const settings = state.settings;
  // Local flag covers the gap before main reports `busy`, so a double click cannot queue a second restart.
  const [clicked, setClicked] = useState(false);
  const busy = clicked || state.busy;

  const lifecycle = async (fn: () => Promise<unknown>) => {
    setClicked(true);
    try {
      await fn();
    } finally {
      setClicked(false);
    }
  };

  const togglePause = () => lifecycle(async () => {
    if (settings === null) return;
    await bridge().updateSettings({ ...settings, paused: !settings.paused });
  });

  const open = (tasks.data?.tasks ?? []).filter((t) => !['MERGED', 'CANCELLED', 'FAILED'].includes(t.state));
  const attention = open.filter((t) => t.state === 'ESCALATED' || t.state === 'PAUSED');
  // Older Leaders omit waitingForName and rateLimitedUntil; the renderer does not parse responses, so default them here.
  const activities = (activity.data?.activities ?? []).map((a) => {
    const loose = a as Partial<TeamActivityView>;
    return { ...a, waitingForName: loose.waitingForName ?? null, rateLimitedUntil: loose.rateLimitedUntil ?? null };
  });
  // Leaders older than the queue view send no `queue`.
  const queue: QueueEntryView[] = (activity.data?.queue as QueueEntryView[] | undefined) ?? [];

  return (
    <div className="stack">
      <div className="grid-3">
        <Card title="This computer">
          {state.leader !== null && (
            <p>
              <Dot tone={state.leader.running ? 'ok' : 'danger'} /> Leader {state.leader.running ? `running on port ${state.leader.port}` : 'stopped'}
            </p>
          )}
          <ErrorNote error={state.leader?.error} />
          <p>
            <Dot tone={state.node.running ? 'ok' : 'danger'} /> Agent {state.node.running ? 'running' : 'stopped'}
            {settings?.paused ? ' (paused)' : ''}
          </p>
          <ErrorNote error={state.node.error} />
          <p>
            <Dot tone={state.connected ? 'ok' : state.authError !== null ? 'danger' : 'warn'} />{' '}
            {state.connected ? 'Connected to the Leader' : state.authError !== null ? 'Not connected to the Leader' : 'Connecting to the Leader…'}
          </p>
          {!state.connected && <ConnectionHint state={state} />}
          <ErrorNote error={state.authError} />
          <div className="row">
            <button disabled={busy} onClick={() => void togglePause()}>
              {settings?.paused ? 'Resume my agent' : 'Pause my agent'}
            </button>
            <button disabled={busy} onClick={() => void lifecycle(() => bridge().restart())}>
              {state.busy ? 'Working…' : 'Restart'}
            </button>
          </div>
        </Card>
        <Card title="My open tasks">
          <p className="big">{open.length}</p>
          <p className="muted">{attention.length > 0 ? `${attention.length} need your attention` : 'Nothing needs you right now'}</p>
        </Card>
        <Card title="Lending">
          <p>
            Mode: <strong>{settings?.lendMode === 'when_idle' ? 'when idle' : settings?.lendMode}</strong>
          </p>
          <p className="muted">Budget for teammates: {formatTokens(settings?.lendTokensPerDay ?? 0)} tokens / day</p>
        </Card>
      </div>

      <ErrorNote error={activity.error} />
      {activity.data === undefined ? <Empty>Loading activity…</Empty> : (
        <>
          <TeamStats activities={activities} queue={queue} />
          <AgentsNow agents={agents.data?.agents} activities={activities} me={state.agentId} onOpenTask={onOpenTask} />
          <WaitsFor activities={activities} queue={queue} onOpenTask={onOpenTask} />
          <QueueCard queue={queue} onOpenTask={onOpenTask} />
        </>
      )}

      <Card title="Team agents">
        <ErrorNote error={agents.error} />
        {agents.data === undefined ? (
          <Empty>Loading…</Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Owner</th>
                <th>Status</th>
                <th>Sessions</th>
                <th>Lent today</th>
                <th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {agents.data.agents.map((a) => {
                const limited = a.rateLimitedUntil !== null && a.rateLimitedUntil > Date.now();
                const tone = a.status !== 'online' ? 'muted' : limited || a.paused ? 'warn' : 'ok';
                return (
                  <tr key={a.id}>
                    <td>
                      {a.id}
                      {a.id === state.agentId && <span className="tag">you</span>}
                    </td>
                    <td>{a.ownerName}</td>
                    <td>
                      <Dot tone={tone} />{' '}
                      {a.status !== 'online' ? 'offline' : limited ? `rate-limited until ${new Date(a.rateLimitedUntil!).toLocaleTimeString()}` : a.paused ? 'paused' : a.lendMode === 'never' ? 'own work only' : 'available'}
                    </td>
                    <td>
                      {a.lockedSessions}/{a.maxSessions} busy
                    </td>
                    <td style={{ minWidth: 140 }}>
                      <Bar value={a.lentToday} max={Math.max(1, a.lendTokensPerDay)} tone={a.budgetRemaining <= 0 ? 'danger' : 'info'} />
                      <span className="hint">
                        {formatTokens(a.lentToday)} / {formatTokens(a.lendTokensPerDay)}
                      </span>
                    </td>
                    <td>{timeAgo(a.lastHeartbeatAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="Team activity">
        {activity.data === undefined ? <Empty>Loading activity…</Empty> : activity.data.activities.length === 0 ? <Empty>No team agents yet.</Empty> : (
          <div className="activity-list">
            {activity.data.activities.map((item) => (
              <article className="activity-item" key={item.key}>
                <div className="activity-main">
                  <div className="activity-title">
                    <Dot tone={item.activityState === 'working' ? 'ok' : item.activityState === 'waiting' ? (item.waitingOn === 'agent' ? 'info' : 'warn') : item.activityState === 'offline' ? 'danger' : 'muted'} />
                    <strong>{item.ownerName}</strong>
                    {item.agentId === state.agentId && <span className="tag">you</span>}
                    <span className="muted">{item.role}{item.sessionId === null ? '' : ` · ${item.sessionId.slice(0, 8)}`}</span>
                  </div>
                  <div className="activity-description">
                    <span>{activityLabel(item.activityState, item.waitingReason, item.stale)}</span>
                    {item.taskId !== null ? (
                      <button className="link activity-task" onClick={() => onOpenTask(item.taskId!)}>#{item.taskId} · {item.taskTitle}</button>
                    ) : item.taskTitle !== null ? <span>{item.taskTitle}</span> : <span className="muted">No assigned task</span>}
                    {item.pairedAgentId !== null && <span className="muted">↔ {item.pairedOwnerName} ({item.role === 'author' ? 'reviewer' : 'author'})</span>}
                  </div>
                  <div className="hint">Updated {timeAgo(item.stateChangedAt)}{item.stale || item.activityState === 'offline' ? ` · last contact ${timeAgo(item.lastHeartbeatAt)}` : ''}</div>
                </div>
              </article>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function activityLabel(state: string, reason: string | null, stale: boolean): string {
  if (stale) return 'Connection may be stale';
  if (state === 'waiting') return reason ?? 'Waiting';
  if (state === 'working') return 'Working';
  if (state === 'paused') return 'Paused';
  if (state === 'offline') return 'Offline';
  return 'Idle';
}

const HINTS: Record<string, string> = {
  tailscale: 'This team is reached through Tailscale. Make sure Tailscale is running and signed in on this computer, and that you accepted the host\'s share (or joined their tailnet).',
  zerotier: 'This team is reached through ZeroTier. Make sure you are connected to the same ZeroTier network as the host.',
  wireguard: 'This team is reached through a WireGuard VPN. Make sure your WireGuard tunnel is up.',
  vpn: 'This team is reached through a VPN. Make sure you are connected to it.',
  local: 'The host is on a local network. You must be on the same Wi-Fi / office network as the host.',
  tunnel: 'The host shares the Leader through a tunnel URL. If the host restarted the tunnel, its address changed — ask for a new join code.',
  public: 'Check that the host\'s app is running and their router forwards the Leader port.',
  loopback: 'The Leader runs on this computer; it may still be starting. Try Restart if this persists.',
};

function ConnectionHint({ state }: { state: AppState }) {
  if (state.leaderNetwork === null) return null;
  const hint = state.mode === 'host' && state.leaderNetwork !== 'loopback' ? HINTS.loopback : HINTS[state.leaderNetwork];
  return <div className="note note-warn small">{hint}</div>;
}
