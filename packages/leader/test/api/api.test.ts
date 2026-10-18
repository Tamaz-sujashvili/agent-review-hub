import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseLeaderConfig, type LeaderConfig, type UiEvent } from '@quorum/protocol';
import { addAgent, listAgents, revokeAgent, startLeader, type LeaderHandle } from '../../src/index.js';
import { openDatabase, type LeaderDb } from '../../src/db/repo.js';
import { silentLogger } from '../../src/logging.js';

let dir: string;
let config: LeaderConfig;
let leader: LeaderHandle;
let base: string;
let tokens: Record<string, string>;
let side: LeaderDb;

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();

async function api(method: string, path: string, who: string | null, body?: unknown) {
  const headers: Record<string, string> = {};
  if (who !== null) headers.authorization = `Bearer ${tokens[who]}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${base}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  return { status: res.status, body: text === '' ? null : (JSON.parse(text) as Record<string, unknown>) };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'quorum-api-'));
  const bare = join(dir, 'remote.git');
  const seed = join(dir, 'seed');
  execFileSync('git', ['init', '--bare', '-b', 'main', bare]);
  execFileSync('git', ['init', '-b', 'main', seed]);
  writeFileSync(join(seed, 'a.txt'), 'one\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-m', 'init');
  git(seed, 'remote', 'add', 'origin', bare);
  git(seed, 'push', '-u', 'origin', 'main');
  writeFileSync(join(seed, 'a.txt'), 'two\n');
  git(seed, 'commit', '-am', 'two');
  git(seed, 'push', 'origin', 'main');

  config = parseLeaderConfig({
    listen: { host: '127.0.0.1', port: 0 },
    dbPath: join(dir, 'leader.db'),
    repo: { remoteUrl: bare, clonePath: join(dir, 'clone') },
    admins: ['admin'],
  });
  tokens = {};
  for (const [id, owner] of [['alice-claude', 'alice'], ['bob-claude', 'bob'], ['admin-console', 'admin']] as const) {
    tokens[owner] = (await addAgent(config.dbPath, { id, owner })).token;
  }
  leader = await startLeader(config, { logger: silentLogger });
  base = `http://127.0.0.1:${leader.port}`;
  side = openDatabase(config.dbPath);
});

afterEach(async () => {
  side.close();
  await leader.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('REST API (§17)', () => {
  it('health needs no auth; everything else needs a valid token', async () => {
    expect(await api('GET', '/api/health', null)).toEqual({ status: 200, body: { ok: true } });
    expect((await api('GET', '/api/tasks', null)).status).toBe(401);
    tokens.bogus = 'qrm_nope';
    expect((await api('GET', '/api/tasks', 'bogus')).body).toMatchObject({ error: 'UNAUTHORIZED' });
  });

  it('creates a task (201, QUEUED, creation event) and lists it', async () => {
    const created = await api('POST', '/api/tasks', 'alice', { title: 'Add greeting', description: 'Say hello', tags: ['js'] });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ state: 'QUEUED', requesterOwner: 'alice', mode: 'own', priority: 1, tags: ['js'] });
    expect(created.body!.waitReason).toMatchObject({ role: 'author', blockers: [{ code: 'agent_offline', agentCount: 1 }] });
    const id = created.body!.id as number;

    const detail = await api('GET', `/api/tasks/${id}`, 'bob');
    expect(detail.body).toMatchObject({ task: { id, waitReason: created.body!.waitReason }, conversations: [], issues: [] });
    expect((detail.body!.events as { toState: string; reason: string }[])[0]).toMatchObject({ toState: 'QUEUED', reason: 'created' });

    expect(((await api('GET', '/api/tasks?mine=true', 'alice')).body!.tasks as unknown[]).length).toBe(1);
    expect(((await api('GET', '/api/tasks?mine=true', 'bob')).body!.tasks as unknown[]).length).toBe(0);
    expect((await api('GET', '/api/tasks/999', 'alice')).status).toBe(404);
    expect((await api('POST', '/api/tasks', 'alice', { title: '' })).body).toMatchObject({ error: 'VALIDATION' });
  });

  it('enforces requester-or-admin permissions and legal states', async () => {
    const id = (await api('POST', '/api/tasks', 'alice', { title: 't', description: 'd' })).body!.id as number;
    expect((await api('POST', `/api/tasks/${id}/cancel`, 'bob', {})).status).toBe(403);
    expect((await api('POST', `/api/tasks/${id}/approve`, 'alice', {})).body).toMatchObject({ error: 'ILLEGAL_TRANSITION' });
    expect((await api('PATCH', `/api/tasks/${id}`, 'alice', { priority: 3 })).body).toMatchObject({ priority: 3 });
    const cancelled = await api('POST', `/api/tasks/${id}/cancel`, 'admin', {});
    expect(cancelled.body).toMatchObject({ state: 'CANCELLED' });
    expect((await api('POST', `/api/tasks/${id}/cancel`, 'alice', {})).status).toBe(409);
  });

  it('rejects cancel while the merge worker is merging the task', async () => {
    const id = (await api('POST', '/api/tasks', 'alice', { title: 't', description: 'd' })).body!.id as number;
    side.tasks.update(id, { state: 'MERGING', author_agent_id: 'alice-claude', branch: `quorum/task-${id}` });
    const res = await api('POST', `/api/tasks/${id}/cancel`, 'alice', {});
    expect(res).toEqual({ status: 409, body: { error: 'CONFLICT', message: 'the task is being merged; wait for it to finish' } });
    expect(side.tasks.require(id).state).toBe('MERGING');
  });

  it('send-back on an escalated task adds a human issue and returns it to the author', async () => {
    const id = (await api('POST', '/api/tasks', 'alice', { title: 't', description: 'd' })).body!.id as number;
    side.tasks.update(id, { state: 'ESCALATED', escalation_reason: 'author_blocked: which default?', author_agent_id: 'alice-claude', branch: `quorum/task-${id}` });
    const res = await api('POST', `/api/tasks/${id}/send-back`, 'alice', { comment: 'Use "world".' });
    expect(res.status).toBe(200);
    // The author agent is offline, so the task pauses waiting for it.
    expect(res.body).toMatchObject({ state: 'PAUSED', pausedFromState: 'AUTHORING', escalationReason: null });
    const detail = await api('GET', `/api/tasks/${id}`, 'alice');
    expect(detail.body!.issues).toEqual([expect.objectContaining({ code: 'I1', source: 'human', severity: 'blocking', comment: 'Use "world".' })]);
  });

  it('approve from ESCALATED queues the merge and merges the branch', async () => {
    const id = (await api('POST', '/api/tasks', 'alice', { title: 'Merge me', description: 'd' })).body!.id as number;
    const clone = join(dir, 'work');
    git(dir, 'clone', join(dir, 'remote.git'), clone);
    git(clone, 'checkout', '-b', `quorum/task-${id}`);
    writeFileSync(join(clone, 'b.txt'), 'b\n');
    git(clone, 'add', '-A');
    git(clone, 'commit', '-m', 'b');
    git(clone, 'push', 'origin', `quorum/task-${id}`);
    const head = git(clone, 'rev-parse', 'HEAD');
    side.tasks.update(id, { state: 'ESCALATED', author_agent_id: 'alice-claude', branch: `quorum/task-${id}`, head_commit: head, base_commit: head });
    expect((await api('POST', `/api/tasks/${id}/approve`, 'alice', {})).body).toMatchObject({ state: 'MERGE_QUEUED' });
    for (let i = 0; i < 100 && side.tasks.require(id).state !== 'MERGED'; i += 1) await new Promise((r) => setTimeout(r, 50));
    expect(side.tasks.require(id).state).toBe('MERGED');
    expect(git(join(dir, 'remote.git'), 'show', 'main:b.txt')).toBe('b');
  });

  it('diff endpoint validates ids and returns git output', async () => {
    const id = (await api('POST', '/api/tasks', 'alice', { title: 't', description: 'd' })).body!.id as number;
    expect((await api('GET', `/api/tasks/${id}/diff`, 'alice')).status).toBe(409);
    const seed = join(dir, 'seed');
    const first = git(seed, 'rev-parse', 'HEAD~1');
    const second = git(seed, 'rev-parse', 'HEAD');
    side.tasks.update(id, { base_commit: first, head_commit: second });
    const diff = await api('GET', `/api/tasks/${id}/diff`, 'alice');
    expect(diff.body!.diff).toContain('+two');
    expect((await api('GET', `/api/tasks/${id}/diff?from=--output=/tmp/x&to=${second}`, 'alice')).body).toMatchObject({ error: 'VALIDATION' });
  });

  it('directives: 409 SESSION_LOCKED on a locked session; otherwise queued and retrievable', async () => {
    const t = side.tasks.insert({ title: 'x', description: 'd', requester_agent_id: 'alice-claude', state: 'AUTHORING', created_at: 1, updated_at: 1, state_entered_at: 1 });
    side.sessions.insert({ id: 's-locked', agent_id: 'bob-claude', state: 'locked', lock_kind: 'task', lock_ref: String(t.id), lock_role: 'reviewer', created_at: 1, last_used_at: 1 });
    expect((await api('POST', '/api/directives', 'alice', { agentId: 'bob-claude', text: 'hi', sessionId: 's-locked' })).body).toMatchObject({ error: 'SESSION_LOCKED' });
    const d = await api('POST', '/api/directives', 'alice', { agentId: 'bob-claude', text: 'What is 6*7?' });
    expect(d.status).toBe(201);
    expect(d.body).toMatchObject({ state: 'queued', requester: 'alice', agentId: 'bob-claude' });
    expect((await api('GET', `/api/directives/${d.body!.id as string}`, 'bob')).body).toMatchObject({ text: 'What is 6*7?' });
  });

  it('lists agents with budget fields and pushes task updates over /ws/ui', async () => {
    const agents = (await api('GET', '/api/agents', 'alice')).body!.agents as { id: string; budgetRemaining: number }[];
    expect(agents.map((a) => a.id).sort()).toEqual(['admin-console', 'alice-claude', 'bob-claude']);

    const ws = new WebSocket(`ws://127.0.0.1:${leader.port}/ws/ui?token=${tokens.alice}`);
    await new Promise((r) => ws.once('open', r));
    const waitForTaskUpdate = (matches: (event: Extract<UiEvent, { type: 'task.updated' }>) => boolean) => new Promise<Extract<UiEvent, { type: 'task.updated' }>>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('timed out waiting for task.updated')), 3_000);
      const listener = (raw: WebSocket.RawData) => {
        const event = JSON.parse(raw.toString()) as UiEvent;
        if (event.type !== 'task.updated' || !matches(event)) return;
        clearTimeout(timeout);
        ws.off('message', listener);
        resolve(event);
      };
      ws.on('message', listener);
    });
    await new Promise((r) => setTimeout(r, 50));
    await api('POST', '/api/tasks', 'alice', { title: 'Pushed', description: 'd' });
    const event = await waitForTaskUpdate((e) => e.data.title === 'Pushed');
    expect(event.data).toMatchObject({ title: 'Pushed' });
    side.agents.update('alice-claude', { status: 'online', last_heartbeat_at: Date.now(), paused: 1 });
    const waitChanged = await waitForTaskUpdate((e) => e.data.title === 'Pushed' && e.data.waitReason?.blockers[0]?.code === 'agent_paused');
    expect(waitChanged.data.waitReason).toMatchObject({ role: 'author', blockers: [{ code: 'agent_paused', agentCount: 1 }] });
    ws.close();

    const bad = new WebSocket(`ws://127.0.0.1:${leader.port}/ws/ui?token=nope`);
    expect(await new Promise((r) => bad.once('close', (code) => r(code)))).toBe(1008);
  });

  it('derives one activity row per session with review pairing and visible idle agents', async () => {
    const now = Date.now();
    side.agents.update('alice-claude', { status: 'online', last_heartbeat_at: now });
    side.agents.update('bob-claude', { status: 'online', last_heartbeat_at: now });
    side.agents.update('admin-console', { status: 'online', last_heartbeat_at: now });
    const task = side.tasks.insert({ title: 'Review activity', description: 'd', requester_agent_id: 'alice-claude', state: 'IN_REVIEW', author_agent_id: 'alice-claude', created_at: now, updated_at: now, state_entered_at: now });
    side.sessions.insert({ id: 'alice-session', agent_id: 'alice-claude', state: 'locked', lock_kind: 'task', lock_ref: String(task.id), lock_role: 'author', created_at: now, last_used_at: now });
    side.sessions.insert({ id: 'bob-session', agent_id: 'bob-claude', state: 'locked', lock_kind: 'task', lock_ref: String(task.id), lock_role: 'reviewer', created_at: now, last_used_at: now });
    side.tasks.update(task.id, { author_session_id: 'alice-session' });
    side.conversations.insert({ id: 'review-conversation', task_id: task.id, author_session_id: 'alice-session', author_agent_id: 'alice-claude', reviewer_session_id: 'bob-session', reviewer_agent_id: 'bob-claude', state: 'active', created_at: now });

    const response = await api('GET', '/api/activity', 'alice');
    expect(response.status).toBe(200);
    const activities = response.body!.activities as { agentId: string; sessionId: string | null; role: string; activityState: string; waitingOn: string | null; taskId: number | null; taskTitle: string | null; pairedAgentId: string | null; pairedSessionId: string | null }[];
    expect(activities).toHaveLength(3);
    expect(activities.find((item) => item.sessionId === 'alice-session')).toMatchObject({
      role: 'author', activityState: 'waiting', waitingOn: 'agent', taskId: task.id,
      taskTitle: 'Review activity', pairedAgentId: 'bob-claude', pairedSessionId: 'bob-session',
    });
    expect(activities.find((item) => item.sessionId === 'bob-session')).toMatchObject({
      role: 'reviewer', activityState: 'working', pairedAgentId: 'alice-claude', pairedSessionId: 'alice-session',
    });
    expect(activities.find((item) => item.agentId === 'admin-console')).toMatchObject({ role: 'idle', activityState: 'idle', sessionId: null });
    side.agents.update('bob-claude', { status: 'offline' });
    const offline = await api('GET', '/api/activity', 'alice');
    expect((offline.body!.activities as { sessionId: string | null; activityState: string }[]).find((item) => item.sessionId === 'bob-session')).toMatchObject({ activityState: 'offline' });
  });

  it('shows who waits for whom: reviewer on author fixes, rate limits, and the explained queue', async () => {
    const now = Date.now();
    side.agents.update('alice-claude', { status: 'online', last_heartbeat_at: now });
    side.agents.update('bob-claude', { status: 'online', last_heartbeat_at: now });
    side.agents.update('admin-console', { status: 'online', last_heartbeat_at: now, rate_limited_until: now + 600_000 });
    const task = side.tasks.insert({ title: 'Fix review notes', description: 'd', requester_agent_id: 'alice-claude', state: 'AUTHORING', author_agent_id: 'alice-claude', created_at: now, updated_at: now, state_entered_at: now });
    side.sessions.insert({ id: 'alice-session', agent_id: 'alice-claude', state: 'locked', lock_kind: 'task', lock_ref: String(task.id), lock_role: 'author', created_at: now, last_used_at: now });
    side.sessions.insert({ id: 'bob-session', agent_id: 'bob-claude', state: 'locked', lock_kind: 'task', lock_ref: String(task.id), lock_role: 'reviewer', created_at: now, last_used_at: now });
    side.tasks.update(task.id, { author_session_id: 'alice-session' });
    side.conversations.insert({ id: 'round-2', task_id: task.id, author_session_id: 'alice-session', author_agent_id: 'alice-claude', reviewer_session_id: 'bob-session', reviewer_agent_id: 'bob-claude', state: 'active', created_at: now });
    const escalated = side.tasks.insert({ title: 'Disputed change', description: 'd', requester_agent_id: 'bob-claude', state: 'ESCALATED', escalation_reason: 'Issues disputed twice', created_at: now, updated_at: now, state_entered_at: now });

    const body = (await api('GET', '/api/activity', 'alice')).body!;
    const activities = body.activities as { agentId: string; sessionId: string | null; activityState: string; waitingOn: string | null; waitingForName: string | null; waitingReason: string | null; rateLimitedUntil: number | null }[];
    expect(activities.find((item) => item.sessionId === 'bob-session')).toMatchObject({
      activityState: 'waiting', waitingOn: 'agent', waitingForName: 'alice', waitingReason: 'Waiting for author fixes',
    });
    expect(activities.find((item) => item.sessionId === 'alice-session')).toMatchObject({ activityState: 'working', waitingForName: null });
    expect(activities.find((item) => item.agentId === 'admin-console')).toMatchObject({
      activityState: 'waiting', waitingOn: 'rate_limit', rateLimitedUntil: now + 600_000,
    });
    expect(body.queue).toEqual([expect.objectContaining({ taskId: escalated.id, position: null, needs: 'human', requesterOwner: 'bob', reason: 'Issues disputed twice' })]);
  });

  it('marks only human pauses as waiting on a human', async () => {
    const now = Date.now();
    // Rate-limited, so the running scheduler does not resume alice's task before we read it.
    side.agents.update('alice-claude', { status: 'online', last_heartbeat_at: now, rate_limited_until: now + 600_000 });
    side.agents.update('bob-claude', { status: 'online', last_heartbeat_at: now });
    for (const [owner, reason] of [['alice', 'rate_limited'], ['bob', 'human']] as const) {
      const agentId = `${owner}-claude`;
      const task = side.tasks.insert({ title: `Paused ${reason}`, description: 'd', requester_agent_id: agentId, state: 'PAUSED', pause_reason: reason, paused_from_state: 'AUTHORING', author_agent_id: agentId, created_at: now, updated_at: now, state_entered_at: now });
      side.sessions.insert({ id: `${owner}-session`, agent_id: agentId, state: 'locked', lock_kind: 'task', lock_ref: String(task.id), lock_role: 'author', created_at: now, last_used_at: now });
    }
    const activities = (await api('GET', '/api/activity', 'alice')).body!.activities as { sessionId: string | null; waitingOn: string | null; waitingReason: string | null; waitingForName: string | null }[];
    expect(activities.find((item) => item.sessionId === 'alice-session')).toMatchObject({ waitingOn: 'scheduler', waitingReason: 'Paused: rate limited', waitingForName: null });
    expect(activities.find((item) => item.sessionId === 'bob-session')).toMatchObject({ waitingOn: 'human', waitingReason: 'Paused by a human', waitingForName: 'bob' });
  });

  it('pushes team activity changes over /ws/ui', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${leader.port}/ws/ui?token=${tokens.alice}`);
    await new Promise((r) => ws.once('open', r));
    const got = new Promise<Extract<UiEvent, { type: 'team.activity.updated' }>>((resolve) => ws.on('message', (raw) => {
      const event = JSON.parse(raw.toString()) as UiEvent;
      if (event.type === 'team.activity.updated') resolve(event);
    }));
    await new Promise((r) => setTimeout(r, 50));
    side.agents.update('alice-claude', { status: 'online', paused: 1, last_heartbeat_at: Date.now() });
    const event = await got;
    expect(event.data.activities.find((item) => item.agentId === 'alice-claude')).toMatchObject({ activityState: 'paused' });
    ws.close();
  });
});

describe('agent token helpers', () => {
  it('rotates, revokes and lists', async () => {
    const before = tokens.bob!;
    const { token } = await addAgent(config.dbPath, { id: 'bob-claude', owner: 'bob' });
    expect(token).not.toBe(before);
    expect((await api('GET', '/api/tasks', 'bob')).status).toBe(401);
    tokens.bob = token;
    expect((await api('GET', '/api/tasks', 'bob')).status).toBe(200);
    await revokeAgent(config.dbPath, 'bob-claude');
    expect((await api('GET', '/api/tasks', 'bob')).status).toBe(401);
    expect((await listAgents(config.dbPath)).find((a) => a.id === 'bob-claude')).toMatchObject({ revoked: true });
    await expect(addAgent(config.dbPath, { id: 'bad id!', owner: 'x' })).rejects.toThrow(/agent id/);
  });
});
