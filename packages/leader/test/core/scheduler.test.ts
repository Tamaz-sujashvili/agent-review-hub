import { beforeEach, describe, expect, it } from 'vitest';
import { parseLeaderConfig, type CmdFrame, type LeaderConfig } from '@quorum/protocol';
import { dayStart, dirsOf, overlap } from '../../src/core/budget.js';
import { EventHandlers } from '../../src/core/handlers.js';
import { LockManager } from '../../src/core/locks.js';
import { Scheduler } from '../../src/core/scheduler.js';
import { transition } from '../../src/core/state-machine.js';
import { openDatabase, type LeaderDb, type TaskRow } from '../../src/db/repo.js';

let db: LeaderDb;
let locks: LockManager;
let handlers: EventHandlers;
let scheduler: Scheduler;
let config: LeaderConfig;
let now: number;
let commands: { agentId: string; frame: CmdFrame }[];
let attention: { taskId: number; reason: string }[];
let idleThreshold: Map<string, number>;

function setup(overrides: Record<string, unknown> = {}) {
  config = parseLeaderConfig({ repo: { remoteUrl: 'file:///unused' }, ...overrides });
  locks = new LockManager(db, { leaseSec: config.timeouts.leaseSec, now: () => now, deliver: (agentId, frame) => commands.push({ agentId, frame }) });
  handlers = new EventHandlers(db, config, locks, {
    now: () => now,
    onSessionOpened: (session, event, request) => scheduler.sessionOpened(session, event, request),
  });
  scheduler = new Scheduler({
    db, config, locks, handlers, now: () => now,
    idleThresholdSec: (id) => idleThreshold.get(id),
    onAttention: (taskId, reason) => attention.push({ taskId, reason }),
  });
}

function agent(id: string, patch: Partial<Parameters<typeof db.agents.insert>[0]> = {}) {
  return db.agents.insert({
    id, owner_name: id.split('-')[0]!, token_hash: 'x', created_at: now, status: 'online', last_heartbeat_at: now,
    lend_mode: 'always', lend_tokens_per_day: 10_000_000, max_sessions: 2, ...patch,
  });
}

function session(id: string, agentId: string, patch: Partial<Parameters<typeof db.sessions.insert>[0]> = {}) {
  return db.sessions.insert({ id, agent_id: agentId, state: 'idle', created_at: now, last_used_at: now, ...patch });
}

/** An idle session that the Leader opened with `profile`. */
function openedSession(id: string, agentId: string, profile: 'author' | 'reviewer' | 'directive', patch: Partial<Parameters<typeof db.sessions.insert>[0]> = {}) {
  return session(id, agentId, { profile, ...patch });
}

function task(patch: Partial<Parameters<typeof db.tasks.insert>[0]> = {}): TaskRow {
  return db.tasks.insert({
    title: 'Task', description: 'Do it', requester_agent_id: 'alice-claude', state: 'QUEUED',
    created_at: now, updated_at: now, state_entered_at: now, ...patch,
  });
}

/** A task that finished authoring and waits for a reviewer, with alice's locked author session 'a'. */
function awaitingReview(patch: Partial<Parameters<typeof db.tasks.insert>[0]> = {}): TaskRow {
  session('a', 'alice-claude', { profile: 'author' });
  const t = task({
    state: 'AWAITING_REVIEWER', author_agent_id: 'alice-claude', author_session_id: 'a', branch: 'quorum/task-1',
    base_commit: 'aaaaaaa', head_commit: 'bbbbbbb', files: JSON.stringify(['src/auth/login.ts']), diff_lines: 10, ...patch,
  });
  locks.lockSession('a', 'task', String(t.id), 'author');
  return t;
}

const sent = (type: string) => commands.filter((c) => c.frame.cmd.type === type);

beforeEach(() => {
  db = openDatabase(':memory:');
  now = 1_000_000_000_000;
  commands = [];
  attention = [];
  idleThreshold = new Map();
  setup();
  agent('alice-claude', { lend_mode: 'never' });
});

describe('budget helpers', () => {
  it('computes overlap from files and directories', () => {
    expect([...dirsOf(['src/auth/a.ts'])]).toEqual(['src/', 'src/auth/']);
    expect(overlap(['src/auth/a.ts'], ['src/auth/a.ts'])).toBeCloseTo(1);
    expect(overlap(['src/auth/a.ts'], ['src/auth/b.ts'])).toBeCloseTo(0.3);
    expect(overlap([], ['x'])).toBe(0);
  });

  it('finds the local day start in a timezone', () => {
    const t = Date.UTC(2026, 9, 18, 15, 30, 12, 345);
    expect(dayStart(t, 'UTC')).toBe(Date.UTC(2026, 9, 18));
    expect(dayStart(t, 'Asia/Tbilisi')).toBe(Date.UTC(2026, 9, 17, 20));
  });
});

describe('author assignment (§9.2)', () => {
  it('own mode binds an idle requester session: QUEUED → AUTHORING with author.start', () => {
    session('a', 'alice-claude', { profile: 'author' });
    const t = task();
    scheduler.schedule();
    const after = db.tasks.require(t.id);
    expect(after).toMatchObject({ state: 'AUTHORING', author_agent_id: 'alice-claude', author_session_id: 'a', branch: `quorum/task-${t.id}` });
    expect(sent('author.start')[0]!.frame.cmd).toMatchObject({ sid: 'a', continueExisting: false });
    expect(db.sessions.require('a')).toMatchObject({ state: 'locked', lock_role: 'author', lock_ref: String(t.id) });
  });

  it('own mode opens a session when none is idle, then binds it on session.opened', () => {
    const t = task();
    scheduler.schedule();
    const open = sent('session.open')[0]!;
    expect(open.frame.cmd).toMatchObject({ profile: 'author' });
    expect(db.messages.require(open.frame.msgId).task_id).toBe(t.id);
    scheduler.schedule();
    expect(sent('session.open')).toHaveLength(1);

    handlers.handle('alice-claude', { type: 'session.opened', inReplyTo: open.frame.msgId, sid: open.frame.cmd.sid, ok: true });
    expect(db.tasks.require(t.id)).toMatchObject({ state: 'AUTHORING', author_session_id: open.frame.cmd.sid });
    expect(sent('author.start')).toHaveLength(1);
  });

  it('own mode waits while the requester is offline, rate-limited or full', () => {
    session('a', 'alice-claude', { profile: 'author' });
    const t = task();
    db.agents.update('alice-claude', { last_heartbeat_at: now - 60_000 });
    scheduler.schedule();
    expect(db.tasks.require(t.id).state).toBe('QUEUED');
    db.agents.update('alice-claude', { status: 'online', last_heartbeat_at: now, rate_limited_until: now + 1000 });
    scheduler.schedule();
    expect(db.tasks.require(t.id).state).toBe('QUEUED');
  });

  it('never reuses a session opened for another role (reviewer sessions are read-only)', () => {
    session('r', 'alice-claude');
    db.messages.insert({
      id: 'open-r', direction: 'to_node', agent_id: 'alice-claude', session_id: 'r', type: 'session.open', created_at: now,
      payload: JSON.stringify({ kind: 'cmd', msgId: 'open-r', cmd: { type: 'session.open', sid: 'r', profile: 'reviewer' } }),
    });
    const t = task();
    scheduler.schedule();
    expect(db.sessions.require('r').state).toBe('idle');
    expect(sent('session.open').at(-1)!.frame.cmd).toMatchObject({ profile: 'author' });
    expect(db.tasks.require(t.id).state).toBe('QUEUED');
  });

  it('explains author blockers and clears the explanation when the author becomes eligible', () => {
    const t = task();
    db.agents.update('alice-claude', { status: 'offline' });
    expect(scheduler.waitReason(t)).toMatchObject({ role: 'author', blockers: [{ code: 'agent_offline', agentCount: 1 }] });

    db.agents.update('alice-claude', { status: 'online', last_heartbeat_at: now, paused: 1 });
    expect(scheduler.waitReason(t)?.blockers[0]?.code).toBe('agent_paused');
    db.agents.update('alice-claude', { paused: 0, rate_limited_until: now + 10_000 });
    expect(scheduler.waitReason(t)?.blockers[0]?.code).toBe('rate_limited');
    db.agents.update('alice-claude', { rate_limited_until: null, max_sessions: 1 });
    session('occupied', 'alice-claude', { profile: 'author', state: 'locked', lock_kind: 'task', lock_ref: '999', lock_role: 'author' });
    expect(scheduler.waitReason(t)?.blockers[0]?.code).toBe('session_capacity');

    db.sessions.update('occupied', { state: 'idle', lock_kind: null, lock_ref: null, lock_role: null });
    scheduler.schedule();
    expect(scheduler.waitReason(db.tasks.require(t.id))).toBeNull();
  });

  it('explains starting and temporarily backed-off author sessions', () => {
    const t = task();
    scheduler.schedule();
    expect(scheduler.waitReason(t)?.blockers[0]?.code).toBe('session_starting');

    const open = sent('session.open')[0]!;
    handlers.handle('alice-claude', { type: 'session.opened', inReplyTo: open.frame.msgId, sid: open.frame.cmd.sid, ok: false, error: 'failed' });
    expect(scheduler.waitReason(db.tasks.require(t.id))?.blockers[0]?.code).toBe('session_start_backoff');
  });

  it('pool mode picks a lending agent when the requester is busy', () => {
    db.agents.update('alice-claude', { max_sessions: 1 });
    session('x', 'alice-claude', { profile: 'author', state: 'opening' });
    agent('carol-claude');
    agent('bob-claude');
    session('b', 'bob-claude', { profile: 'author' });
    session('c', 'carol-claude', { profile: 'author' });
    const t = task({ mode: 'pool' });
    scheduler.schedule();
    expect(db.tasks.require(t.id)).toMatchObject({ state: 'AUTHORING', author_agent_id: expect.stringMatching(/^(bob|carol)-claude$/) });
  });
});

describe('reviewer assignment (§9.3)', () => {
  it('explains why no reviewer is eligible, including capacity, lending, idle, and budget blockers', () => {
    const t = awaitingReview();
    expect(scheduler.waitReason(t)?.blockers[0]?.code).toBe('no_candidate_agent');

    agent('bob-claude', { lend_mode: 'never' });
    expect(scheduler.waitReason(t)?.blockers[0]?.code).toBe('lending_disabled');

    db.agents.update('bob-claude', { lend_mode: 'when_idle', human_idle_sec: 10 });
    idleThreshold.set('bob-claude', 300);
    expect(scheduler.waitReason(t)?.blockers[0]?.code).toBe('owner_active');

    db.agents.update('bob-claude', { lend_mode: 'always', human_idle_sec: null, lend_tokens_per_day: 0 });
    expect(scheduler.waitReason(t)?.blockers[0]?.code).toBe('budget_exhausted');

    db.agents.update('bob-claude', { lend_tokens_per_day: 10_000_000, max_sessions: 1 });
    session('bob-busy', 'bob-claude', { state: 'locked', lock_kind: 'task', lock_ref: '999', lock_role: 'author' });
    expect(scheduler.waitReason(t)?.blockers[0]?.code).toBe('session_capacity');
  });

  it('never picks the author agent; creates a conversation and sends review.start (round 1)', () => {
    agent('bob-claude');
    session('b', 'bob-claude', { profile: 'reviewer' });
    const t = awaitingReview();
    scheduler.schedule();
    const after = db.tasks.require(t.id);
    expect(after).toMatchObject({ state: 'IN_REVIEW', review_round: 1 });
    const [conv] = db.conversations.find({ task_id: t.id });
    expect(conv).toMatchObject({ reviewer_agent_id: 'bob-claude', reviewer_session_id: 'b', author_session_id: 'a', state: 'active' });
    expect(sent('review.start')[0]!.frame.cmd).toMatchObject({ sid: 'b', conversationId: conv!.id, round: 1 });
  });

  it('applies hard filters: lend mode, idle threshold, budget, rate limit, paused', () => {
    agent('bob-claude', { lend_mode: 'never' });
    agent('carol-claude', { lend_mode: 'when_idle', human_idle_sec: 10 });
    agent('dave-claude', { lend_tokens_per_day: 1 });
    agent('erin-claude', { rate_limited_until: now + 60_000 });
    agent('fred-claude', { paused: 1 });
    for (const id of ['bob', 'carol', 'dave', 'erin', 'fred']) session(id[0]!, `${id}-claude`, { profile: 'reviewer' });
    const t = awaitingReview();
    idleThreshold.set('carol-claude', 300);
    scheduler.schedule();
    expect(db.tasks.require(t.id).state).toBe('AWAITING_REVIEWER');

    db.agents.update('carol-claude', { human_idle_sec: 600 });
    scheduler.schedule();
    expect(db.conversations.find({ task_id: t.id })[0]?.reviewer_agent_id).toBe('carol-claude');
  });

  it('prefers the agent with file affinity, then the least recently assigned', () => {
    agent('bob-claude', { last_assigned_at: 5 });
    agent('carol-claude', { last_assigned_at: 1 });
    session('b', 'bob-claude', { profile: 'reviewer', files: JSON.stringify(['src/auth/login.ts']) });
    session('c', 'carol-claude', { profile: 'reviewer' });
    const t = awaitingReview();
    scheduler.schedule();
    expect(db.conversations.find({ task_id: t.id })[0]?.reviewer_agent_id).toBe('bob-claude');
  });

  it('preserves constrained reviewer capacity for another waiting task', () => {
    db.agents.update('alice-claude', { status: 'offline' });
    agent('bob-claude', { max_sessions: 2 });
    agent('carol-claude', { max_sessions: 2 });
    session('bob-author', 'bob-claude', { profile: 'author' });
    session('carol-author', 'carol-claude', { profile: 'author' });
    const flexible = task({
      requester_agent_id: 'alice-claude', state: 'AWAITING_REVIEWER', author_agent_id: 'bob-claude',
      author_session_id: 'bob-author', branch: 'quorum/task-flexible', base_commit: 'aaaaaaa', head_commit: 'bbbbbbb',
    });
    const constrained = task({
      requester_agent_id: 'bob-claude', state: 'AWAITING_REVIEWER', author_agent_id: 'carol-claude',
      author_session_id: 'carol-author', branch: 'quorum/task-constrained', base_commit: 'aaaaaaa', head_commit: 'bbbbbbb',
    });
    locks.lockSession('bob-author', 'task', String(flexible.id), 'author');
    locks.lockSession('carol-author', 'task', String(constrained.id), 'author');
    session('bob-reviewer', 'bob-claude', { profile: 'reviewer' });
    session('carol-reviewer', 'carol-claude', { profile: 'reviewer' });

    scheduler.schedule();

    expect(db.conversations.find({ task_id: flexible.id, state: 'active' })[0]?.reviewer_agent_id).toBe('carol-claude');
    expect(db.conversations.find({ task_id: constrained.id, state: 'active' })[0]?.reviewer_agent_id).toBe('bob-claude');
  });

  it('prefers a reviewer who has not already dropped this task, but falls back to them', () => {
    agent('bob-claude');
    agent('carol-claude');
    session('b', 'bob-claude', { profile: 'reviewer', files: JSON.stringify(['src/auth/login.ts']) });
    session('c', 'carol-claude', { profile: 'reviewer' });
    const t = awaitingReview();
    session('b-old', 'bob-claude', { profile: 'reviewer', state: 'lost' });
    db.conversations.insert({ id: 'old', task_id: t.id, author_agent_id: 'alice-claude', author_session_id: 'a', reviewer_agent_id: 'bob-claude', reviewer_session_id: 'b-old', state: 'abandoned', created_at: now });
    scheduler.schedule();
    expect(db.conversations.find({ task_id: t.id, state: 'active' })[0]?.reviewer_agent_id).toBe('carol-claude');

    session('a2', 'alice-claude', { profile: 'author' });
    const t2 = task({ state: 'AWAITING_REVIEWER', author_agent_id: 'alice-claude', author_session_id: 'a2', branch: 'quorum/task-9', base_commit: 'aaaaaaa', head_commit: 'bbbbbbb' });
    locks.lockSession('a2', 'task', String(t2.id), 'author');
    db.agents.update('carol-claude', { status: 'offline' });
    db.conversations.insert({ id: 'old2', task_id: t2.id, author_agent_id: 'alice-claude', author_session_id: 'a2', reviewer_agent_id: 'bob-claude', reviewer_session_id: 'b-old', state: 'abandoned', created_at: now });
    scheduler.schedule();
    expect(db.conversations.find({ task_id: t2.id, state: 'active' })[0]?.reviewer_agent_id).toBe('bob-claude');
  });

  it('raises needs-attention once when nobody can review', () => {
    setup({ timeouts: { noReviewerNotifyAfterSec: 10 } });
    const t = awaitingReview();
    scheduler.schedule();
    expect(attention).toEqual([]);
    now += 11_000;
    db.agents.update('alice-claude', { last_heartbeat_at: now });
    scheduler.schedule();
    scheduler.schedule();
    expect(attention).toEqual([{ taskId: t.id, reason: 'no_reviewer' }]);
  });
});

describe('liveness (§10.3–§10.5)', () => {
  it('marks stale agents offline and clears expired rate limits', () => {
    agent('bob-claude', { last_heartbeat_at: now - 60_000, rate_limited_until: now - 1 });
    scheduler.schedule();
    expect(db.agents.require('bob-claude')).toMatchObject({ status: 'offline', rate_limited_until: null });
  });

  it('lease expiry on the reviewer abandons the conversation and returns the task to AWAITING_REVIEWER', () => {
    agent('bob-claude');
    session('b', 'bob-claude', { profile: 'reviewer' });
    const t = awaitingReview();
    scheduler.schedule();
    expect(db.tasks.require(t.id).state).toBe('IN_REVIEW');
    now += (config.timeouts.leaseSec + 1) * 1000;
    db.agents.update('alice-claude', { last_heartbeat_at: now });
    db.sessions.update('a', { lease_expires_at: now + 100_000 });
    db.agents.update('bob-claude', { status: 'offline' });
    scheduler.schedule();
    expect(db.tasks.require(t.id).state).toBe('AWAITING_REVIEWER');
    expect(db.conversations.find({ task_id: t.id })[0]?.state).toBe('abandoned');
    expect(db.sessions.require('b').state).toBe('lost');
  });

  it('pool task with an unavailable author is requeued after the grace period and continued by another agent', () => {
    setup({ timeouts: { authorReconnectGraceSec: 30 } });
    agent('carol-claude');
    session('c', 'carol-claude', { profile: 'author' });
    session('a', 'alice-claude', { profile: 'author', state: 'lost' });
    const t = task({
      mode: 'pool', state: 'PAUSED', paused_from_state: 'AUTHORING', pause_reason: 'author_unavailable',
      author_agent_id: 'alice-claude', author_session_id: 'a', branch: 'quorum/task-1', head_commit: 'abcdef1',
    });
    db.agents.update('alice-claude', { status: 'offline' });
    scheduler.schedule();
    expect(db.tasks.require(t.id).state).toBe('PAUSED');
    now += 31_000;
    db.agents.update('carol-claude', { last_heartbeat_at: now });
    scheduler.schedule();
    scheduler.schedule();
    expect(db.tasks.require(t.id)).toMatchObject({ state: 'AUTHORING', author_agent_id: 'carol-claude' });
    expect(sent('author.start').at(-1)!.frame.cmd).toMatchObject({ sid: 'c', continueExisting: true });
  });

  it('own task whose author session was lost resumes on a new session once the agent is back', () => {
    session('a', 'alice-claude', { profile: 'author', state: 'lost' });
    const t = task({
      state: 'PAUSED', paused_from_state: 'AUTHORING', pause_reason: 'author_unavailable',
      author_agent_id: 'alice-claude', author_session_id: 'a', branch: 'quorum/task-1', head_commit: 'abcdef1',
    });
    scheduler.schedule();
    const open = sent('session.open')[0]!;
    handlers.handle('alice-claude', { type: 'session.opened', inReplyTo: open.frame.msgId, sid: open.frame.cmd.sid, ok: true });
    expect(db.tasks.require(t.id)).toMatchObject({ state: 'AUTHORING', author_session_id: open.frame.cmd.sid });
    expect(sent('author.start').at(-1)!.frame.cmd).toMatchObject({ continueExisting: true });
  });

  it('session.opened for a task a human paused meanwhile leaves the session idle and does not throw', () => {
    const t = task();
    scheduler.schedule();
    const open = sent('session.open')[0]!;
    transition(db, t.id, 'PAUSED', { reason: 'human', actor: 'human:alice', at: now });

    expect(() => handlers.handle('alice-claude', { type: 'session.opened', inReplyTo: open.frame.msgId, sid: open.frame.cmd.sid, ok: true })).not.toThrow();
    expect(db.tasks.require(t.id)).toMatchObject({ state: 'PAUSED', pause_reason: 'human', paused_from_state: 'QUEUED', author_session_id: null });
    expect(db.sessions.require(open.frame.cmd.sid)).toMatchObject({ state: 'idle', lock_ref: null, profile: 'author' });
    expect(sent('author.start')).toEqual([]);
  });

  it('own task paused by a rate limit resumes on the same session when the limit clears', () => {
    session('a', 'alice-claude', { profile: 'author' });
    const t = task({ state: 'AUTHORING', author_agent_id: 'alice-claude', author_session_id: 'a', branch: 'quorum/task-1' });
    locks.lockSession('a', 'task', String(t.id), 'author');
    db.tasks.update(t.id, { state: 'PAUSED', paused_from_state: 'AUTHORING', pause_reason: 'rate_limited' });
    db.agents.update('alice-claude', { rate_limited_until: now + 5000 });
    scheduler.schedule();
    expect(db.tasks.require(t.id).state).toBe('PAUSED');
    now += 6000;
    db.agents.update('alice-claude', { last_heartbeat_at: now });
    db.sessions.update('a', { lease_expires_at: now + 100_000 });
    scheduler.schedule();
    expect(db.tasks.require(t.id).state).toBe('AUTHORING');
    expect(sent('author.start').at(-1)!.frame.cmd.sid).toBe('a');
  });

  it('times out unanswered turns as turn.failed TIMEOUT', () => {
    setup({ timeouts: { turnTimeoutSec: 10 }, limits: { maxTurnRetries: 0 } });
    session('a', 'alice-claude', { profile: 'author' });
    const t = task();
    scheduler.schedule();
    now += 10_000 + 61_000;
    db.agents.update('alice-claude', { last_heartbeat_at: now });
    db.sessions.update('a', { lease_expires_at: now + 100_000 });
    scheduler.schedule();
    expect(sent('task.cancel')).toHaveLength(1);
    expect(db.tasks.require(t.id)).toMatchObject({ state: 'ESCALATED', escalation_reason: 'author_turn_failed:TIMEOUT' });
  });
});

describe('sessions and directives', () => {
  it('counts opening sessions against capacity', () => {
    db.agents.update('alice-claude', { max_sessions: 1 });
    session('x', 'alice-claude', { profile: 'author', state: 'opening' });
    const t = task();
    scheduler.schedule();
    expect(db.tasks.require(t.id).state).toBe('QUEUED');
    expect(sent('session.open')).toEqual([]);
  });

  it('times out session.open and backs the agent off', () => {
    const t = task();
    scheduler.schedule();
    const sid = sent('session.open')[0]!.frame.cmd.sid;
    now += 61_000;
    db.agents.update('alice-claude', { last_heartbeat_at: now });
    scheduler.schedule();
    expect(db.sessions.require(sid).state).toBe('lost');
    expect(sent('session.open')).toHaveLength(1);
    expect(db.tasks.require(t.id).state).toBe('QUEUED');
  });

  it('closes idle sessions after the TTL', () => {
    session('a', 'alice-claude', { profile: 'author', last_used_at: now - 61 * 60_000 });
    scheduler.schedule();
    expect(db.sessions.require('a').state).toBe('closing');
    expect(sent('session.close')[0]!.frame.cmd.sid).toBe('a');
  });

  it('never reuses an idle session opened for another role', () => {
    agent('bob-claude');
    openedSession('b-review', 'bob-claude', 'reviewer');
    db.directives.insert({ id: 'd1', requester: 'alice', agent_id: 'bob-claude', text: 'Where is X?', state: 'queued', created_at: now });
    scheduler.schedule();
    expect(db.directives.require('d1')).toMatchObject({ state: 'queued', session_id: null });
    expect(sent('directive.run')).toHaveLength(0);
    expect(sent('session.open').at(-1)!.frame.cmd).toMatchObject({ profile: 'directive' });
  });

  it('reviews on a reviewer session even when the agent has an idle author session on the same files', () => {
    agent('bob-claude');
    openedSession('b-author', 'bob-claude', 'author', { files: JSON.stringify(['src/auth/login.ts']), task_history: '[7]' });
    const t = awaitingReview();
    scheduler.schedule();
    expect(db.tasks.require(t.id).state).toBe('AWAITING_REVIEWER');
    expect(sent('review.start')).toHaveLength(0);
    const open = sent('session.open').at(-1)!;
    expect(open).toMatchObject({ agentId: 'bob-claude', frame: { cmd: { profile: 'reviewer' } } });
    handlers.handle('bob-claude', { type: 'session.opened', inReplyTo: open.frame.msgId, sid: open.frame.cmd.sid, ok: true });
    expect(db.tasks.require(t.id).state).toBe('IN_REVIEW');
    expect(sent('review.start')[0]!.frame.cmd).toMatchObject({ sid: open.frame.cmd.sid });
  });

  it('runs a queued directive on an idle session with the requester name', () => {
    session('a', 'alice-claude', { profile: 'directive' });
    db.directives.insert({ id: 'd1', requester: 'alice', agent_id: 'alice-claude', text: 'What is X?', state: 'queued', created_at: now });
    scheduler.schedule();
    expect(db.directives.require('d1')).toMatchObject({ state: 'running', session_id: 'a' });
    expect(sent('directive.run')[0]!.frame.cmd).toMatchObject({ directiveId: 'd1', requester: 'alice', text: 'What is X?' });
  });
});

describe('queue explanation', () => {
  it('explains an own-only task blocked by its rate-limited requester, without assigning anything', () => {
    db.agents.update('alice-claude', { rate_limited_until: now + 60_000 });
    const t = task();
    const queue = scheduler.queueSnapshot();
    expect(queue).toEqual([expect.objectContaining({
      taskId: t.id, position: 1, needs: 'author', waitingOn: 'rate_limit', requesterOwner: 'alice',
      reason: "Own-only task: alice's agent is rate-limited",
      candidates: [{ agentId: 'alice-claude', ownerName: 'alice', blocker: 'rate-limited' }],
    })]);
    expect(commands).toHaveLength(0);
    expect(db.tasks.require(t.id).state).toBe('QUEUED');
  });

  it('lists reviewers before authors and names why each agent cannot review', () => {
    agent('bob-claude', { status: 'offline' });
    agent('carol-claude', { lend_mode: 'when_idle' });
    agent('dave-claude', { lend_tokens_per_day: 0 });
    const review = awaitingReview();
    const write = task({ mode: 'pool', priority: 0 });
    const queue = scheduler.queueSnapshot();
    expect(queue.map((e) => [e.taskId, e.position, e.needs])).toEqual([[review.id, 1, 'reviewer'], [write.id, 2, 'author']]);
    expect(queue[0]).toMatchObject({
      waitingOn: 'agent', authorOwnerName: 'alice',
      reason: 'No free reviewer: bob offline, carol in use by its owner (lends when idle), dave out of lending budget',
    });
    expect(queue[0]!.candidates.find((c) => c.agentId === 'alice-claude')).toMatchObject({ blocker: `wrote #${review.id}` });
  });

  it('explains reviewer capacity reservations instead of promising assignment', () => {
    db.agents.update('alice-claude', { max_sessions: 1 });
    agent('bob-claude', { max_sessions: 1 });
    const t = task({ requester_agent_id: 'bob-claude', mode: 'own' });
    awaitingReview();
    const queued = scheduler.queueSnapshot().find((entry) => entry.taskId === t.id);
    expect(queued).toMatchObject({
      waitingOn: 'agent',
      candidates: [{ agentId: 'bob-claude', ownerName: 'bob', blocker: 'reserving capacity for reviews' }],
    });
    expect(commands).toHaveLength(0);
  });

  it('reports a task an eligible agent will pick up on the next pass', () => {
    agent('bob-claude');
    const t = task({ mode: 'pool' });
    expect(scheduler.queueSnapshot()[0]).toMatchObject({ taskId: t.id, waitingOn: 'scheduler', reason: 'Being assigned on the next scheduler pass' });
  });

  it('orders merges like the merge worker and lists human decisions without a position', () => {
    const merging = task({ state: 'MERGING', approved_at: now - 3000 });
    const second = task({ state: 'MERGE_QUEUED', approved_at: now - 1000 });
    const first = task({ state: 'MERGE_QUEUED', approved_at: now - 2000 });
    const escalated = task({ state: 'ESCALATED', escalation_reason: 'Reviewer and author disagree', state_entered_at: now - 5000 });
    const paused = task({ state: 'PAUSED', pause_reason: 'human', paused_from_state: 'AUTHORING', state_entered_at: now - 1000 });
    const queue = scheduler.queueSnapshot();
    expect(queue.map((e) => [e.taskId, e.position, e.needs, e.reason])).toEqual([
      [first.id, 1, 'merge', `Merging #${merging.id} first`],
      [second.id, 2, 'merge', '2 merges ahead'],
      [escalated.id, null, 'human', 'Reviewer and author disagree'],
      [paused.id, null, 'human', 'Paused by a human'],
    ]);
    expect(queue[2]).toMatchObject({ waitingOn: 'human', requesterOwner: 'alice' });
  });
  it('explains paused tasks the way handlePaused resumes them', () => {
    db.agents.update('alice-claude', { rate_limited_until: now + 60_000 });
    const review = task({ state: 'PAUSED', pause_reason: 'rate_limited', paused_from_state: 'IN_REVIEW', author_agent_id: 'alice-claude', state_entered_at: now - 2000 });
    const writing = task({ state: 'PAUSED', pause_reason: 'rate_limited', paused_from_state: 'AUTHORING', author_agent_id: 'alice-claude', state_entered_at: now - 1000 });
    const queue = scheduler.queueSnapshot();
    expect(queue.find((e) => e.taskId === review.id)).toMatchObject({
      position: null, needs: 'reviewer', waitingOn: 'scheduler', reason: 'Paused: rate limited; resumes on the next scheduler pass', candidates: [],
    });
    expect(queue.find((e) => e.taskId === writing.id)).toMatchObject({
      position: null, needs: 'author', waitingOn: 'rate_limit', reason: "Paused: rate limited; resumes when alice's agent is back (rate-limited)",
    });
    now += config.timeouts.authorReconnectGraceSec * 1000;
    db.agents.update('alice-claude', { status: 'offline', rate_limited_until: null });
    expect(scheduler.queueSnapshot().find((e) => e.taskId === writing.id)).toMatchObject({
      needs: 'human', waitingOn: 'human', reason: 'Paused: rate limited; the author agent is unavailable: reassign to the pool, wait, or cancel',
    });
  });
  it('treats a task whose session is still opening as waiting on that agent, not as next', () => {
    const t = task();
    scheduler.schedule();
    expect(sent('session.open')).toHaveLength(1);
    expect(scheduler.queueSnapshot()[0]).toMatchObject({
      taskId: t.id, waitingOn: 'agent', reason: "Opening an author session on alice's agent",
      candidates: [{ agentId: 'alice-claude', ownerName: 'alice', blocker: 'opening a session' }],
    });
  });
});
