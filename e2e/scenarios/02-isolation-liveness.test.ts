import { afterEach, describe, expect, it } from 'vitest';
import type { TaskDetail } from '@quorum/protocol';
import { stateHistory, waitFor, waitForState } from '../helpers/api.js';
import { E2E_READY, Harness, aliceAndBob } from '../helpers/harness.js';
import { anyTask, approve, authorDone, type MockScript } from '../helpers/mock-script.js';

// Spec §21.2 scenarios 5–11.

const greetFile = (tag: string) => ({ 'src/greet.js': `export const greet = (name) => \`Hello \${name}\`; // ${tag}\n` });

/** Invariant §3.2 over the transcript: every task command went to a session that only ever served that task while locked. */
function assertNoCrossTaskDelivery(details: TaskDetail[]): void {
  const owner = new Map<string, number>();
  for (const d of details) {
    for (const m of d.messages) {
      if (m.direction !== 'to_node' || m.sessionId === null || m.taskId === null) continue;
      const prev = owner.get(`${m.sessionId}`);
      if (prev !== undefined && prev !== m.taskId) {
        // Allowed only if the previous task had already finished before this message.
        const prevDetail = details.find((x) => x.task.id === prev);
        const finishedAt = prevDetail?.events.at(-1)?.at ?? Infinity;
        expect(m.createdAt, `session ${m.sessionId} served task ${m.taskId} while locked to ${prev}`).toBeGreaterThanOrEqual(finishedAt);
      }
      owner.set(m.sessionId, m.taskId);
    }
  }
}

describe.skipIf(!E2E_READY)('isolation and liveness', () => {
  let h: Harness;
  afterEach(async () => h?.close());

  it('#5a concurrent tasks get different reviewer sessions on the only reviewer', async () => {
    h = await Harness.create();
    await h.startLeader();
    const slowApprove: MockScript = { reviewer: anyTask([approve(), approve()]), behaviors: { delayMs: 1500 } };
    const alice = await h.addAgent({ id: 'alice-claude', script: { author: anyTask([authorDone(greetFile('a'))]) }, config: { lendMode: 'never' } });
    const carol = await h.addAgent({ id: 'carol-claude', script: { author: anyTask([authorDone({ 'src/other.js': 'export {};\n' })]) }, config: { lendMode: 'never' } });
    await h.addAgent({ id: 'bob-claude', script: slowApprove, config: { maxSessions: 2 } });

    const t1 = await alice.api.createTask({ title: 'Task one', description: 'x' });
    const t2 = await carol.api.createTask({ title: 'Task two', description: 'x' });
    const [d1, d2] = await Promise.all([waitForState(alice.api, t1.id, 'MERGED'), waitForState(carol.api, t2.id, 'MERGED')]);

    expect(d1.conversations[0]!.reviewerAgentId).toBe('bob-claude');
    expect(d2.conversations[0]!.reviewerAgentId).toBe('bob-claude');
    expect(d1.conversations[0]!.reviewerSessionId).not.toBe(d2.conversations[0]!.reviewerSessionId);
    assertNoCrossTaskDelivery([d1, d2]);
  });

  it('#5b with maxSessions=1 the second task waits in AWAITING_REVIEWER until the first finishes', async () => {
    h = await Harness.create();
    await h.startLeader();
    const alice = await h.addAgent({ id: 'alice-claude', script: { author: anyTask([authorDone(greetFile('a'))]) }, config: { lendMode: 'never' } });
    const carol = await h.addAgent({ id: 'carol-claude', script: { author: anyTask([authorDone({ 'src/other.js': 'export {};\n' })]) }, config: { lendMode: 'never' } });
    await h.addAgent({ id: 'bob-claude', script: { reviewer: anyTask([approve()]), behaviors: { delayMs: 2500 } }, config: { maxSessions: 1 } });

    const t1 = await alice.api.createTask({ title: 'First', description: 'x' });
    await waitForState(alice.api, t1.id, 'IN_REVIEW');
    const t2 = await carol.api.createTask({ title: 'Second', description: 'x' });
    await waitForState(carol.api, t2.id, 'AWAITING_REVIEWER');
    expect((await alice.api.getTask(t1.id)).task.state).toBe('IN_REVIEW');
    const waiting = await carol.api.getTask(t2.id);
    expect(waiting.task.waitReason).toMatchObject({ role: 'reviewer' });
    expect(waiting.task.waitReason?.blockers).toContainEqual(expect.objectContaining({ code: 'session_capacity', agentCount: 1 }));

    const d1 = await waitForState(alice.api, t1.id, 'MERGED');
    const d2 = await waitForState(carol.api, t2.id, 'MERGED');
    expect(d2.task.waitReason).toBeNull();
    const reviewStart2 = d2.events.find((e) => e.toState === 'IN_REVIEW')!.at;
    // bob's only slot was held by task 1 until its terminal state.
    expect(reviewStart2).toBeGreaterThanOrEqual(d1.events.at(-1)!.at);
    assertNoCrossTaskDelivery([d1, d2]);
  });

  it('#5c an agent that reviewed earlier authors its own task in a fresh author session', async () => {
    h = await Harness.create();
    await h.startLeader();
    const alice = await h.addAgent({ id: 'alice-claude', script: { author: anyTask([authorDone(greetFile('a'))]) }, config: { lendMode: 'never' } });
    const bob = await h.addAgent({ id: 'bob-claude', script: { author: anyTask([authorDone({ 'src/bob.js': 'export const bob = 1;\n' })]), reviewer: anyTask([approve()]) } });
    const t1 = await alice.api.createTask({ title: 'Alice task', description: 'x' });
    await waitForState(alice.api, t1.id, 'MERGED');
    await h.addAgent({ id: 'carol-claude', script: { reviewer: anyTask([approve()]) } });
    const t2 = await bob.api.createTask({ title: 'Bob task', description: 'x' });
    const done = await waitForState(bob.api, t2.id, 'MERGED');
    const reviewSid = (await alice.api.getTask(t1.id)).conversations[0]!.reviewerSessionId;
    expect(done.task.authorSessionId).not.toBe(reviewSid);
    expect(done.messages.some((m) => m.type === 'turn.failed')).toBe(false);
  });

  it('#6 reviewer disconnect → lease expiry → new reviewer in a NEW conversation', async () => {
    h = await Harness.create();
    const { alice } = await aliceAndBob(h, {
      alice: { author: anyTask([authorDone(greetFile('a'))]) },
      bob: { reviewer: anyTask([approve()]), behaviors: { delayMs: 30_000 } },
    });
    const task = await alice.api.createTask({ title: 'Reviewer dies', description: 'x' });
    await waitForState(alice.api, task.id, 'IN_REVIEW');

    await h.stopNode('bob-claude');
    await h.addAgent({ id: 'carol-claude', script: { reviewer: anyTask([approve()]) } });
    const done = await waitForState(alice.api, task.id, 'MERGED', { timeoutMs: 45_000 });

    expect(done.conversations.map((c) => [c.reviewerAgentId, c.state])).toEqual([
      ['bob-claude', 'abandoned'],
      ['carol-claude', 'closed'],
    ]);
    expect(stateHistory(done)).toContain('AWAITING_REVIEWER');
  });

  it('#7 author disconnect in pool mode → PAUSED → QUEUED → another author continues the branch', async () => {
    h = await Harness.create({ timeouts: { authorReconnectGraceSec: 3 } });
    await h.startLeader();
    const alice = await h.addAgent({
      id: 'alice-claude',
      script: { author: anyTask([authorDone(greetFile('alice-wip'))]), behaviors: { delayMs: 30_000 } },
      config: { lendMode: 'never' },
    });
    const task = await alice.api.createTask({ title: 'Pool task', description: 'x', mode: 'pool' });
    await waitForState(alice.api, task.id, 'AUTHORING');

    await h.stopNode('alice-claude');
    // In pool mode any lending agent may take over authoring, so both helpers can author and review.
    const helper = (tag: string): MockScript => ({ author: anyTask([authorDone(greetFile(tag))]), reviewer: anyTask([approve()]) });
    await h.addAgent({ id: 'carol-claude', script: helper('carol') });
    await h.addAgent({ id: 'bob-claude', script: helper('bob') });
    const done = await waitForState(alice.api, task.id, 'MERGED', { timeoutMs: 60_000 });

    expect(stateHistory(done)).toEqual(expect.arrayContaining(['PAUSED', 'QUEUED']));
    const newAuthor = done.task.authorAgentId;
    expect(['bob-claude', 'carol-claude']).toContain(newAuthor);
    const restart = done.messages.find((m) => m.type === 'author.start' && m.agentId === newAuthor);
    expect((restart?.payload as { continueExisting: boolean }).continueExisting).toBe(true);
    expect(done.conversations.at(-1)?.reviewerAgentId).not.toBe(newAuthor);
  });

  it('#8 author disconnect in own mode → PAUSED → same author resumes after reconnect', async () => {
    h = await Harness.create({ timeouts: { authorReconnectGraceSec: 60 } });
    const { alice } = await aliceAndBob(h, {
      alice: { author: anyTask([authorDone(greetFile('a')), authorDone(greetFile('a2'))]), behaviors: { delayMs: 4000 } },
      bob: { reviewer: anyTask([approve()]) },
    });
    const task = await alice.api.createTask({ title: 'Own task', description: 'x' });
    await waitForState(alice.api, task.id, 'AUTHORING');
    await h.stopNode('alice-claude');
    await waitForState(alice.api, task.id, 'PAUSED', { timeoutMs: 20_000 });

    await h.startNode('alice-claude');
    const done = await waitForState(alice.api, task.id, 'MERGED', { timeoutMs: 45_000 });
    expect(done.task.authorAgentId).toBe('alice-claude');
  });

  it('#9 reviewer rate-limited → excluded → another reviewer picked', async () => {
    h = await Harness.create();
    const { alice } = await aliceAndBob(h, {
      alice: { author: anyTask([authorDone(greetFile('a'))]) },
      bob: { reviewer: anyTask([{ failTurnWith: 'RATE_LIMITED' }, approve()]) },
    });
    await h.addAgent({ id: 'carol-claude', script: { reviewer: anyTask([approve()]) }, config: { lendTokensPerDay: 1 } });
    const task = await alice.api.createTask({ title: 'Rate limited', description: 'x' });
    // carol's tiny budget makes bob the first choice; once bob is rate-limited carol is still ineligible by budget,
    // so raise it now to let the scheduler pick her.
    await waitFor(
      'bob rate limited',
      () => alice.api.call('listAgents'),
      (r) => (r.agents.find((a) => a.id === 'bob-claude')?.rateLimitedUntil ?? 0) > Date.now(),
    );
    h.agent('carol-claude').daemon?.updateSettings({ lendTokensPerDay: 100_000_000 });
    const done = await waitForState(alice.api, task.id, 'MERGED');
    expect(done.conversations.at(-1)?.reviewerAgentId).toBe('carol-claude');
  });

  it('#10 budget exhausted → never chosen; no reviewer → needs attention, waits', async () => {
    h = await Harness.create({ timeouts: { noReviewerNotifyAfterSec: 2 } });
    const { alice } = await aliceAndBob(
      h,
      { alice: { author: anyTask([authorDone(greetFile('a'))]) }, bob: { reviewer: anyTask([approve()]) } },
      { bob: { lendTokensPerDay: 1 } },
    );
    const task = await alice.api.createTask({ title: 'No budget', description: 'x' });
    await waitForState(alice.api, task.id, 'AWAITING_REVIEWER');
    await new Promise((r) => setTimeout(r, 3000));
    const still = await alice.api.getTask(task.id);
    expect(still.task.state).toBe('AWAITING_REVIEWER');
    expect(still.conversations).toEqual([]);
  });

  it('#11 lend mode when_idle: busy human → not chosen; idle → chosen', async () => {
    h = await Harness.create();
    await h.startLeader();
    const alice = await h.addAgent({ id: 'alice-claude', script: { author: anyTask([authorDone(greetFile('a'))]) }, config: { lendMode: 'never' } });
    await h.addAgent({ id: 'bob-claude', script: { reviewer: anyTask([approve()]) }, config: { lendMode: 'when_idle', idleThresholdSec: 999_999_999 } });
    const task = await alice.api.createTask({ title: 'Idle lending', description: 'x' });
    await waitForState(alice.api, task.id, 'AWAITING_REVIEWER');
    await new Promise((r) => setTimeout(r, 1500));
    expect((await alice.api.getTask(task.id)).task.state).toBe('AWAITING_REVIEWER');

    h.agent('bob-claude').daemon?.updateSettings({ idleThresholdSec: 0 });
    await waitForState(alice.api, task.id, 'MERGED');
  });
});
