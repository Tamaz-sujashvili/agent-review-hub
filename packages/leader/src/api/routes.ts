import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  API_ERROR_HTTP_STATUS,
  API_ROUTES,
  AnswerTaskRequestSchema,
  CreateApiTokenRequestSchema,
  CreateDirectiveRequestSchema,
  CreateTaskRequestSchema,
  DiffQuerySchema,
  ListSessionsQuerySchema,
  ListTasksQuerySchema,
  PatchTaskRequestSchema,
  SendBackRequestSchema,
  isTerminalTaskState,
  type ApiErrorCode,
  type ApiRouteName,
  type LeaderConfig,
  type TaskState,
  type TokenScope,
} from '@quorum/protocol';
import { apiTokenView, mintApiToken, resolvePrincipal } from '../core/api-tokens.js';
import type { EventHandlers } from '../core/handlers.js';
import { LockError, type LockManager } from '../core/locks.js';
import type { MergeWorker } from '../core/merge-worker.js';
import { nextIssueCode } from '../core/review.js';
import type { Scheduler } from '../core/scheduler.js';
import { IllegalTransitionError, transition, transitionToAuthorState } from '../core/state-machine.js';
import { NotFoundError, type AgentRow, type LeaderDb, type TaskRow } from '../db/repo.js';
import type { LeaderGit } from '../git/leader-git.js';
import { silentLogger, type Logger } from '../logging.js';
import { agentView, directiveView, sessionView, taskDetail, taskView, teamActivity } from './views.js';

// Spec §17 — every route comes from API_ROUTES; responses are validated against its schemas.

export class ApiHttpError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface ApiDeps {
  db: LeaderDb;
  config: LeaderConfig;
  locks: LockManager;
  handlers: EventHandlers;
  scheduler: Scheduler;
  mergeWorker: MergeWorker;
  git: LeaderGit;
  now?: () => number;
  logger?: Logger;
}

interface Ctx {
  agent: AgentRow | null;
  scope: TokenScope | null;
  id: string | undefined;
  query: unknown;
  body: unknown;
}

const SHA = /^[0-9a-f]{7,64}$/;

/** Resolves a bearer token (agent token or API token) to its non-revoked agent (constant-time hash comparison). */
export function authenticate(db: LeaderDb, token: string | undefined): AgentRow | null {
  return resolvePrincipal(db, token)?.agent ?? null;
}

export function registerRoutes(server: FastifyInstance, deps: ApiDeps): void {
  const { db, config, locks, handlers, scheduler, mergeWorker, git } = deps;
  const now = deps.now ?? Date.now;
  const log = deps.logger ?? silentLogger;

  const bearer = (req: FastifyRequest) => {
    const header = req.headers.authorization;
    return header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
  };

  const task = (id: string | undefined): TaskRow => {
    const n = Number(id);
    const t = Number.isSafeInteger(n) ? db.tasks.get(n) : undefined;
    if (t === undefined) throw new ApiHttpError('NOT_FOUND', `task ${id} not found`);
    return t;
  };

  const taskResponse = (t: TaskRow) => taskView(db, t, scheduler.waitReason(t));
  const taskDetailResponse = (t: TaskRow) => taskDetail(db, t, scheduler.waitReason(t));

  // Actions taken through a requester API token are recorded as `token:<owner>`: possibly a script or agent, not the person.
  const actor = (ctx: Ctx) => `${ctx.scope === 'requester' ? 'token' : 'human'}:${ctx.agent?.owner_name ?? 'unknown'}`;

  const requireRequesterOrAdmin = (ctx: Ctx, t: TaskRow) => {
    const owner = ctx.agent?.owner_name;
    const requester = db.agents.get(t.requester_agent_id)?.owner_name;
    if (owner === undefined || (owner !== requester && !config.admins.includes(owner))) {
      throw new ApiHttpError('FORBIDDEN', 'only the requester or an admin can do this');
    }
  };

  const requireState = (t: TaskRow, allowed: readonly string[], action: string) => {
    if (!allowed.includes(t.state)) throw new ApiHttpError('ILLEGAL_TRANSITION', `cannot ${action} a task in ${t.state}`);
  };

  /** Cancels any in-flight reviewer turn, releases the reviewer and abandons the active conversation. */
  const releaseReviewer = (taskId: number, reason: string) => {
    for (const c of db.conversations.find({ task_id: taskId, state: 'active' })) {
      const s = db.sessions.get(c.reviewer_session_id);
      if (s?.state === 'locked' && s.lock_ref === String(taskId)) {
        locks.sendToSession(s.id, { type: 'task.cancel', sid: s.id, taskId });
        locks.releaseSession(s.id, 'idle');
      }
      db.conversations.update(c.id, { state: 'abandoned', ended_at: now() });
      log.info({ taskId, conversationId: c.id, reason }, 'conversation abandoned by human action');
    }
  };

  const cancelAuthorTurn = (t: TaskRow) => {
    if (t.author_session_id === null) return;
    const s = db.sessions.get(t.author_session_id);
    if (s?.state === 'locked' && s.lock_ref === String(t.id)) locks.sendToSession(s.id, { type: 'task.cancel', sid: s.id, taskId: t.id });
  };

  const queueForMerge = (taskId: number, reason: string, who: string) => {
    for (const i of db.issues.find({ task_id: taskId, status: 'open' })) db.issues.update(i.id, { status: 'closed_by_human' });
    transition(db, taskId, 'MERGE_QUEUED', { reason, actor: who, at: now() });
    const t = db.tasks.require(taskId);
    db.tasks.update(taskId, { approved_at: t.approved_at ?? now(), escalation_reason: null });
    if (db.mergeQueue.get(taskId) === undefined) db.mergeQueue.insert({ task_id: taskId, enqueued_at: now() });
  };

  /** Sends a task back to its author with `comment` as a human blocking issue (inside a transaction). */
  function sendBack(ctx: Ctx, t: TaskRow, comment: string) {
    if (t.state === 'IN_REVIEW') {
      for (const c of db.conversations.find({ task_id: t.id, state: 'active' })) {
        locks.sendToSession(c.reviewer_session_id, { type: 'task.cancel', sid: c.reviewer_session_id, taskId: t.id });
      }
    }
    db.issues.insert({
      task_id: t.id,
      code: nextIssueCode(db, t.id),
      source: 'human',
      severity: 'blocking',
      comment,
      status: 'open',
      raised_round: t.review_round,
      created_at: now(),
    });
    db.tasks.update(t.id, { review_round: Math.max(0, t.review_round - 1), escalation_reason: null });
    const after = transitionToAuthorState(db, t.id, 'AUTHORING', { reason: 'sent_back_by_human', actor: actor(ctx), at: now() });
    if (after.state === 'AUTHORING') handlers.sendAuthor(t.id, 'revise');
    return taskResponse(db.tasks.require(t.id));
  }

  const handlersByRoute: { [R in ApiRouteName]: (ctx: Ctx) => unknown | Promise<unknown> } = {
    health: () => ({ ok: true }),

    listAgents: () => ({
      agents: db.agents.all().filter((a) => a.revoked === 0).map((a) => agentView(db, a, now(), config.dayBoundaryTz)),
    }),

    teamActivity: () => ({ activities: teamActivity(db, now()), queue: scheduler.queueSnapshot() }),

    listSessions: (ctx) => {
      const q = ListSessionsQuerySchema.parse(ctx.query ?? {});
      const rows = q.agentId === undefined ? db.sessions.all() : db.sessions.find({ agent_id: q.agentId });
      return { sessions: rows.filter((s) => s.state !== 'closed').map(sessionView) };
    },

    listTasks: (ctx) => {
      const q = ListTasksQuerySchema.parse(ctx.query ?? {});
      let rows = q.state === undefined ? db.tasks.all() : db.tasks.find({ state: q.state });
      if (q.mine === 'true') rows = rows.filter((t) => db.agents.get(t.requester_agent_id)?.owner_name === ctx.agent?.owner_name);
      return { tasks: rows.sort((a, b) => b.id - a.id).map(taskResponse) };
    },

    createTask: (ctx) => {
      const body = CreateTaskRequestSchema.parse(ctx.body);
      const agent = ctx.agent!;
      const created = db.withTx(() => {
        const at = now();
        const t = db.tasks.insert({
          title: body.title,
          description: body.description,
          tags: JSON.stringify(body.tags),
          priority: body.priority,
          mode: body.mode,
          requester_agent_id: agent.id,
          state: 'QUEUED',
          created_at: at,
          updated_at: at,
          state_entered_at: at,
        });
        db.taskEvents.insert({ task_id: t.id, from_state: null, to_state: 'QUEUED', reason: 'created', actor: actor(ctx), data: '{}', at });
        return t;
      });
      scheduler.trigger();
      return taskResponse(created);
    },

    getTask: (ctx) => taskDetailResponse(task(ctx.id)),

    getTaskDiff: async (ctx) => {
      const t = task(ctx.id);
      const q = DiffQuerySchema.parse(ctx.query ?? {});
      const from = q.from ?? t.base_commit;
      const to = q.to ?? t.head_commit;
      if (from === null || to === null) throw new ApiHttpError('CONFLICT', 'task has no commits yet');
      if (!SHA.test(from) || !SHA.test(to)) throw new ApiHttpError('VALIDATION', 'from/to must be commit ids');
      const diff = await git.exclusive(() => git.diff(from, to));
      return { from, to, diff };
    },

    patchTask: (ctx) => {
      const body = PatchTaskRequestSchema.parse(ctx.body);
      return db.withTx(() => {
        const t = task(ctx.id);
        requireRequesterOrAdmin(ctx, t);
        if (isTerminalTaskState(t.state as TaskState)) throw new ApiHttpError('ILLEGAL_TRANSITION', 'task is finished');
        if (body.mode !== undefined && !['QUEUED', 'PAUSED'].includes(t.state)) {
          throw new ApiHttpError('ILLEGAL_TRANSITION', 'mode can only change while QUEUED or PAUSED');
        }
        const updated = db.tasks.update(t.id, {
          ...(body.priority !== undefined ? { priority: body.priority } : {}),
          ...(body.tags !== undefined ? { tags: JSON.stringify(body.tags) } : {}),
          ...(body.mode !== undefined ? { mode: body.mode } : {}),
          updated_at: now(),
        });
        scheduler.trigger();
        return taskResponse(updated);
      });
    },

    cancelTask: (ctx) => {
      const t = task(ctx.id);
      requireRequesterOrAdmin(ctx, t);
      if (isTerminalTaskState(t.state as TaskState)) throw new ApiHttpError('ILLEGAL_TRANSITION', 'task is finished');
      // The worker may already be pushing to main; a cancel now could leave the code merged under a CANCELLED task.
      if (t.state === 'MERGING') throw new ApiHttpError('CONFLICT', 'the task is being merged; wait for it to finish');
      handlers.finishTask(t.id, 'CANCELLED', 'cancelled_by_human', actor(ctx));
      scheduler.trigger();
      return taskResponse(db.tasks.require(t.id));
    },

    approveTask: (ctx) => {
      const result = db.withTx(() => {
        const t = task(ctx.id);
        requireRequesterOrAdmin(ctx, t);
        requireState(t, ['ESCALATED', 'IN_REVIEW', 'AWAITING_REVIEWER'], 'approve');
        if (t.head_commit === null) throw new ApiHttpError('CONFLICT', 'nothing to merge yet');
        if (t.state === 'IN_REVIEW') {
          for (const c of db.conversations.find({ task_id: t.id, state: 'active' })) {
            locks.sendToSession(c.reviewer_session_id, { type: 'task.cancel', sid: c.reviewer_session_id, taskId: t.id });
          }
        }
        queueForMerge(t.id, 'approved_by_human', actor(ctx));
        return taskResponse(db.tasks.require(t.id));
      });
      mergeWorker.kick();
      return result;
    },

    sendBackTask: (ctx) => {
      const body = SendBackRequestSchema.parse(ctx.body);
      return db.withTx(() => {
        const t = task(ctx.id);
        requireRequesterOrAdmin(ctx, t);
        requireState(t, ['ESCALATED', 'IN_REVIEW', 'AWAITING_REVIEWER'], 'send back');
        return sendBack(ctx, t, body.comment);
      });
    },

    answerTask: (ctx) => {
      const body = AnswerTaskRequestSchema.parse(ctx.body);
      return db.withTx(() => {
        const t = task(ctx.id);
        requireRequesterOrAdmin(ctx, t);
        if (t.state !== 'ESCALATED' || !t.escalation_reason?.startsWith('author_blocked:')) {
          throw new ApiHttpError('ILLEGAL_TRANSITION', `task ${t.id} is not waiting for an answer (state ${t.state})`);
        }
        return sendBack(ctx, t, body.answer);
      });
    },

    createApiToken: (ctx) => {
      const body = CreateApiTokenRequestSchema.parse(ctx.body);
      const { row, token } = mintApiToken(db, ctx.agent!.id, body.label ?? '', now());
      log.info({ agentId: row.agent_id, tokenId: row.id }, 'api token created');
      return { ...apiTokenView(row), token };
    },

    listApiTokens: (ctx) => ({ tokens: db.apiTokens.find({ agent_id: ctx.agent!.id }).map(apiTokenView) }),

    revokeApiToken: (ctx) => {
      const row = ctx.id === undefined ? undefined : db.apiTokens.get(ctx.id);
      if (row === undefined || row.agent_id !== ctx.agent!.id) throw new ApiHttpError('NOT_FOUND', `token ${ctx.id} not found`);
      return apiTokenView(row.revoked_at === null ? db.apiTokens.update(row.id, { revoked_at: now() }) : row);
    },

    reassignReviewer: (ctx) => {
      const result = db.withTx(() => {
        const t = task(ctx.id);
        requireRequesterOrAdmin(ctx, t);
        requireState(t, ['IN_REVIEW'], 'reassign the reviewer of');
        releaseReviewer(t.id, 'reassigned_by_human');
        transition(db, t.id, 'AWAITING_REVIEWER', { reason: 'reviewer_reassigned_by_human', actor: actor(ctx), at: now() });
        return taskResponse(db.tasks.require(t.id));
      });
      scheduler.trigger();
      return result;
    },

    pauseTask: (ctx) =>
      db.withTx(() => {
        const t = task(ctx.id);
        requireRequesterOrAdmin(ctx, t);
        requireState(t, ['QUEUED', 'AUTHORING', 'AWAITING_REVIEWER', 'IN_REVIEW', 'SYNCING', 'ESCALATED'], 'pause');
        if (t.state === 'IN_REVIEW') {
          // A paused review would hold the reviewer hostage; give the slot back and re-review on resume.
          releaseReviewer(t.id, 'paused_by_human');
          transition(db, t.id, 'AWAITING_REVIEWER', { reason: 'paused_by_human', actor: actor(ctx), at: now() });
        }
        if (t.state === 'AUTHORING' || t.state === 'SYNCING') cancelAuthorTurn(t);
        transition(db, t.id, 'PAUSED', { reason: 'human', actor: actor(ctx), at: now() });
        return taskResponse(db.tasks.require(t.id));
      }),

    resumeTask: (ctx) => {
      const t = task(ctx.id);
      requireRequesterOrAdmin(ctx, t);
      if (t.state !== 'PAUSED' || t.pause_reason !== 'human') throw new ApiHttpError('ILLEGAL_TRANSITION', 'task was not paused by a human');
      scheduler.resumeFromHumanPause(t.id);
      scheduler.trigger();
      return taskResponse(db.tasks.require(t.id));
    },

    createDirective: (ctx) => {
      const body = CreateDirectiveRequestSchema.parse(ctx.body);
      const created = db.withTx(() => {
        if (db.agents.get(body.agentId) === undefined) throw new ApiHttpError('NOT_FOUND', `agent ${body.agentId} not found`);
        if (body.sessionId !== undefined) {
          const s = db.sessions.get(body.sessionId);
          if (s === undefined || s.agent_id !== body.agentId) throw new ApiHttpError('NOT_FOUND', 'session not found for this agent');
          if (s.state === 'locked') throw new ApiHttpError('SESSION_LOCKED', 'session is locked to other work');
          if (s.state !== 'idle') throw new ApiHttpError('CONFLICT', `session is ${s.state}`);
          if (s.profile !== 'directive') throw new ApiHttpError('CONFLICT', `session is a ${s.profile ?? 'legacy'} session; directives need a directive session`);
          // Targeting a session skips the scheduler's lending checks (spec §13 queued path), so restrict it to the owner.
          if (db.agents.require(body.agentId).owner_name !== ctx.agent!.owner_name) {
            throw new ApiHttpError('FORBIDDEN', "only the agent's owner can target a specific session; omit sessionId to queue the directive");
          }
        }
        const id = randomUUID();
        db.directives.insert({ id, requester: ctx.agent!.owner_name, agent_id: body.agentId, text: body.text, state: 'queued', created_at: now() });
        if (body.sessionId !== undefined) scheduler.bindDirective(id, body.sessionId);
        return db.directives.require(id);
      });
      scheduler.trigger();
      return directiveView(created);
    },

    getDirective: (ctx) => {
      const d = ctx.id === undefined ? undefined : db.directives.get(ctx.id);
      if (d === undefined) throw new ApiHttpError('NOT_FOUND', `directive ${ctx.id} not found`);
      return directiveView(d);
    },
  };

  for (const name of Object.keys(API_ROUTES) as ApiRouteName[]) {
    const def = API_ROUTES[name];
    const handler = handlersByRoute[name];
    server.route({
      method: def.method,
      url: def.path,
      handler: async (req, reply) => {
        try {
          const principal = def.auth === 'none' ? null : resolvePrincipal(db, bearer(req));
          if (def.auth !== 'none' && principal === null) throw new ApiHttpError('UNAUTHORIZED', 'missing or invalid token');
          if (principal?.scope === 'requester') {
            if (!('requesterToken' in def && def.requesterToken)) {
              throw new ApiHttpError('FORBIDDEN', `a requester token cannot call ${name}; use the Quorum app for this`);
            }
            db.apiTokens.update(principal.tokenId!, { last_used_at: now() });
          }
          const params = req.params as { id?: string };
          const ctx: Ctx = { agent: principal?.agent ?? null, scope: principal?.scope ?? null, id: params.id, query: req.query, body: req.body ?? {} };
          const result = await handler(ctx);
          return reply.code(def.status).send(def.response.parse(result));
        } catch (error) {
          const { code, message } = toApiError(error);
          if (code === 'INTERNAL') log.error({ err: error, route: name }, 'api error');
          return reply.code(API_ERROR_HTTP_STATUS[code]).send({ error: code, message });
        }
      },
    });
  }
}

function toApiError(error: unknown): { code: ApiErrorCode; message: string } {
  if (error instanceof ApiHttpError) return { code: error.code, message: error.message };
  if (error instanceof IllegalTransitionError) return { code: 'ILLEGAL_TRANSITION', message: error.message };
  if (error instanceof NotFoundError) return { code: 'NOT_FOUND', message: error.message };
  if (error instanceof LockError) return { code: 'CONFLICT', message: error.message };
  if (error instanceof Error && error.name === 'ZodError') return { code: 'VALIDATION', message: error.message };
  return { code: 'INTERNAL', message: error instanceof Error ? error.message : String(error) };
}
