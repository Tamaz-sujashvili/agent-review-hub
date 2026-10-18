import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import type { TaskDetail, TaskView } from '@quorum/protocol';
import { waitFor } from '../helpers/api.js';
import { Harness, type Agent } from '../helpers/harness.js';
import { approve, authorDone, authorRevised, forTask, type MockScript, type MockTurn } from '../helpers/mock-script.js';
import { mainLog, readMain } from '../helpers/toy-project.js';

const TASK_COUNT = 60;
const DEADLINE_MS = 10 * 60_000;
const SEED = Number(process.env.QUORUM_LOAD_SEED ?? 20261018);

interface PlannedTask {
  title: string;
  path: string;
  content: string;
  mode: 'own' | 'pool';
  needsChange: boolean;
}

interface TaskSnapshot {
  id: number;
  title: string;
  mode: string;
  state: string;
  created_at: number;
  state_entered_at: number;
  escalation_reason: string | null;
}

/** Seeded randomness makes the same workload and mock delays reproducible. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function planTasks(rng: () => number): PlannedTask[] {
  const order = Array.from({ length: TASK_COUNT }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  const changes = new Set(order.slice(0, TASK_COUNT / 5));
  return Array.from({ length: TASK_COUNT }, (_, i) => {
    const title = `load-${String(i + 1).padStart(3, '0')}`;
    return {
      title,
      path: `load/${title}.txt`,
      content: `${title}: complete\n`,
      mode: i % 2 === 0 ? 'own' : 'pool',
      needsChange: changes.has(i),
    };
  });
}

function mockScript(plan: PlannedTask[], rng: () => number): MockScript {
  const delayed = (turn: MockTurn): MockTurn => ({ ...turn, delayMs: 50 + Math.floor(rng() * 451) });
  return {
    // Both profiles are available: pool tasks may make a lending reviewer an author.
    author: plan.map((task) => forTask(task.title, (task.needsChange
      ? [authorDone({ [task.path]: `${task.title}: draft\n` }), authorRevised({ [task.path]: task.content }, [{ issue: 'I1', action: 'fixed' }])]
      : [authorDone({ [task.path]: task.content })]).map(delayed))),
    reviewer: plan.map((task) => forTask(task.title, (task.needsChange
      ? [{ reply: {
          verdict: 'request_changes', summary: 'one change required', previousIssues: [],
          newIssues: [{ severity: 'blocking', file: task.path, line: 1, comment: 'Replace the draft with the completed content.' }],
        } }, approve([{ issue: 'I1', status: 'resolved' }])]
      : [approve()]).map(delayed))),
    behaviors: { tokensPerTurn: { input: 1000, output: 100 } },
  };
}

/**
 * Passive audit triggers in the disposable fixture DB capture every committed lock change
 * and task command, including changes occurring between polls. Rollbacks roll back the audit too.
 */
function installAudit(db: DatabaseSync): void {
  const owners = `(SELECT COUNT(*) FROM (
    SELECT id FROM tasks WHERE author_session_id = NEW.id AND state NOT IN ('MERGED', 'CANCELLED', 'FAILED')
    UNION SELECT task_id FROM conversations WHERE reviewer_session_id = NEW.id AND state = 'active'
  ))`;
  db.exec(`
    CREATE TABLE load_locks (
      seq INTEGER PRIMARY KEY, sid TEXT, old_state TEXT, old_kind TEXT, old_ref TEXT,
      state TEXT, kind TEXT, ref TEXT, role TEXT, owners INTEGER
    );
    CREATE TRIGGER load_lock_insert AFTER INSERT ON sessions BEGIN
      INSERT INTO load_locks VALUES (NULL, NEW.id, NULL, NULL, NULL,
        NEW.state, NEW.lock_kind, NEW.lock_ref, NEW.lock_role, ${owners});
    END;
    CREATE TRIGGER load_lock_update AFTER UPDATE OF state, lock_kind, lock_ref, lock_role ON sessions
    WHEN OLD.state IS NOT NEW.state OR OLD.lock_kind IS NOT NEW.lock_kind
      OR OLD.lock_ref IS NOT NEW.lock_ref OR OLD.lock_role IS NOT NEW.lock_role
    BEGIN
      INSERT INTO load_locks VALUES (NULL, NEW.id, OLD.state, OLD.lock_kind, OLD.lock_ref,
        NEW.state, NEW.lock_kind, NEW.lock_ref, NEW.lock_role, ${owners});
    END;
    CREATE TABLE load_deliveries (
      msg_id TEXT PRIMARY KEY, sid TEXT, task_id INTEGER, state TEXT, kind TEXT, ref TEXT
    );
    CREATE TRIGGER load_task_command AFTER INSERT ON messages
    WHEN NEW.direction = 'to_node' AND json_extract(NEW.payload, '$.cmd.taskId') IS NOT NULL
    BEGIN
      INSERT INTO load_deliveries VALUES (
        NEW.id, NEW.session_id, json_extract(NEW.payload, '$.cmd.taskId'),
        (SELECT state FROM sessions WHERE id = NEW.session_id),
        (SELECT lock_kind FROM sessions WHERE id = NEW.session_id),
        (SELECT lock_ref FROM sessions WHERE id = NEW.session_id)
      );
    END;
  `);
}

function snapshots(db: DatabaseSync): TaskSnapshot[] {
  return db.prepare('SELECT id, title, mode, state, created_at, state_entered_at, escalation_reason FROM tasks ORDER BY id').all() as unknown as TaskSnapshot[];
}

function finished(task: TaskSnapshot): boolean {
  return task.state === 'MERGED' || task.state === 'ESCALATED';
}

function report(db: DatabaseSync, startedAt: number, final: boolean): void {
  const now = Date.now();
  const tasks = snapshots(db);
  const states: Record<string, number> = {};
  for (const task of tasks) states[task.state] = (states[task.state] ?? 0) + 1;
  console.info(`[load] seed=${SEED} elapsed=${((now - startedAt) / 1000).toFixed(1)}s states=${JSON.stringify(states)}`);
  if (final) {
    console.info('[load] slowest tasks:', tasks
      .map((task) => ({
        id: task.id, title: task.title, mode: task.mode, state: task.state,
        seconds: Number((((finished(task) ? task.state_entered_at : now) - task.created_at) / 1000).toFixed(2)),
        escalation: task.escalation_reason,
      }))
      .sort((a, b) => b.seconds - a.seconds || a.id - b.id)
      .slice(0, 10));
  }
}

function assertLocks(db: DatabaseSync): void {
  expect.soft(db.prepare(`SELECT * FROM load_locks WHERE old_state = 'locked' AND state = 'locked'
    AND (old_kind IS NOT kind OR old_ref IS NOT ref)`).all(), 'a locked session was retargeted without release').toEqual([]);
  expect.soft(db.prepare("SELECT * FROM load_locks WHERE state = 'locked' AND owners > 1").all(), 'a session belonged to two active tasks').toEqual([]);
  expect.soft(db.prepare("SELECT * FROM load_deliveries WHERE state IS NOT 'locked' OR kind IS NOT 'task' OR ref IS NOT CAST(task_id AS TEXT)").all(),
    'task commands must match the session lock at enqueue time').toEqual([]);
  expect.soft(db.prepare("SELECT id, state, lock_kind, lock_ref, lock_role FROM sessions WHERE state = 'locked' OR lock_kind IS NOT NULL OR lock_ref IS NOT NULL OR lock_role IS NOT NULL OR lease_expires_at IS NOT NULL").all(),
    'all session locks must be released before teardown').toEqual([]);
  expect.soft(db.prepare("SELECT * FROM conversations WHERE state = 'active'").all(), 'no conversation should remain active').toEqual([]);
  expect.soft(db.prepare('SELECT * FROM merge_queue').all(), 'merge queue must be drained').toEqual([]);
}

async function assertMerges(h: Harness, details: TaskDetail[], plan: PlannedTask[]): Promise<void> {
  const history = await mainLog(h.bare);
  const commits = history.flatMap((commit) => {
    const taskId = /^Quorum-Task: (\d+)$/m.exec(commit.message)?.[1];
    return taskId === undefined ? [] : [{ ...commit, taskId: Number(taskId) }];
  });
  const merged = details.filter((d) => d.task.state === 'MERGED');
  expect.soft(history, 'main must contain only the seed commit and approved task merges').toHaveLength(merged.length + 1);
  expect.soft(commits.map((c) => c.taskId).sort((a, b) => a - b), 'exactly one main commit per merged task').toEqual(merged.map((d) => d.task.id).sort((a, b) => a - b));
  for (const d of details) {
    const approval = d.messages.findLast((m) => m.direction === 'from_node' && m.type === 'review.completed'
      && (m.payload as { output: { verdict: string } }).output.verdict === 'approve');
    if (d.task.state !== 'MERGED') {
      expect.soft(d.task.mergedCommit, `unmerged task #${d.task.id} has a commit`).toBeNull();
      continue;
    }
    expect.soft(approval, `task #${d.task.id} merged without reviewer approval`).toBeDefined();
    expect.soft(d.task.approvedAt, `task #${d.task.id} has no approval timestamp`).not.toBeNull();
    expect.soft((approval?.payload as { reviewedCommit?: string } | undefined)?.reviewedCommit).toBe(d.task.lastReviewedCommit);
    expect.soft(d.issues.filter((i) => i.severity === 'blocking' && i.status === 'open'), `task #${d.task.id} merged with open issues`).toEqual([]);
    expect.soft(commits.find((c) => c.taskId === d.task.id)?.sha, `task #${d.task.id} records the wrong merge`).toBe(d.task.mergedCommit);
    const expected = plan.find((task) => task.title === d.task.title)!;
    expect.soft(await readMain(h.bare, expected.path), `task #${d.task.id} has incorrect merged content`).toBe(expected.content);
    const mergeStarted = d.events.find((e) => e.toState === 'MERGING')?.at;
    expect.soft(approval?.createdAt ?? Infinity, `task #${d.task.id} merged before approval`).toBeLessThanOrEqual(mergeStarted ?? -1);
  }
}

describe('opt-in load test', () => {
  let h: Harness | undefined;
  let db: DatabaseSync | undefined;
  afterEach(async () => {
    try { db?.close(); } finally { await h?.close(); }
  });

  it('settles 60 mixed tasks on eight nodes within ten minutes without violating locks or approvals', async () => {
    expect(Number.isSafeInteger(SEED) && SEED >= 0 && SEED <= 0xffff_ffff, 'QUORUM_LOAD_SEED must be an unsigned 32-bit integer').toBe(true);
    const rng = random(SEED);
    const plan = planTasks(rng);
    h = await Harness.create();
    await h.startLeader();
    db = new DatabaseSync(h.leaderConfig.dbPath);
    installAudit(db);
    const authors: Agent[] = [];
    // Four task owners and four lending peers. Each daemon has two session slots.
    for (let i = 0; i < 8; i++) {
      const author = i < 4;
      const id = `load-${author ? 'author' : 'reviewer'}-${i % 4 + 1}`;
      const agent = await h.addAgent({
        id, owner: id, script: mockScript(plan, rng),
        config: { lendMode: author ? 'never' : 'always', maxSessions: 2 },
      });
      if (author) authors.push(agent);
    }
    const api = authors[0]!.api;
    await waitFor('all eight nodes online', () => api.call('listAgents'), (r) => r.agents.filter((a) => a.status === 'online').length === 8);

    const startedAt = Date.now();
    console.info(`[load] starting ${TASK_COUNT} tasks on eight nodes; seed=${SEED}; fixture=${h.dir}`);
    try {
      const tasks: TaskView[] = await Promise.all(plan.map((task, i) => authors[i % authors.length]!.api.createTask({
        title: task.title, description: `Write ${task.path}; review and merge it.`, mode: task.mode,
      })));
      expect(tasks).toHaveLength(TASK_COUNT);
      expect(plan.filter((task) => task.needsChange)).toHaveLength(12);
      let lastReport = startedAt;
      while (Date.now() - startedAt < DEADLINE_MS) {
        if (snapshots(db).every(finished)) break;
        if (Date.now() - lastReport >= 30_000) {
          report(db, startedAt, false);
          lastReport = Date.now();
        }
        await sleep(250);
      }

      const stuck = snapshots(db).filter((task) => !finished(task));
      expect.soft(stuck, `tasks still unfinished at the ten-minute deadline; seed=${SEED}`).toEqual([]);
      // ESCALATED ends the wait, but this workload has no reason to need a human decision.
      const escalated = snapshots(db).filter((task) => task.state === 'ESCALATED');
      expect.soft(escalated, `tasks escalated instead of merging; seed=${SEED}`).toEqual([]);
      assertLocks(db);
      const details = await Promise.all(tasks.map((task) => api.getTask(task.id)));
      expect.soft(details.flatMap((d) => d.messages.filter((m) => m.type === 'review.completed'
        && (m.payload as { output: { verdict: string } }).output.verdict === 'request_changes').map(() => d.task.title)).sort(),
      'exactly 20% of tasks should receive exactly one change request').toEqual(plan.filter((task) => task.needsChange).map((task) => task.title).sort());
      await assertMerges(h, details, plan);
    } finally {
      report(db, startedAt, true);
      console.info(`[load] fixture=${h.dir} (QUORUM_E2E_KEEP=1 preserves databases and worktrees)`);
    }
  });
});
