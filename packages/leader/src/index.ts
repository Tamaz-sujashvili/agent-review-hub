import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import pino from 'pino';
import type { LeaderConfig } from '@quorum/protocol';
import { registerRoutes } from './api/routes.js';
import { mintApiToken, revokeAgentApiTokens } from './core/api-tokens.js';
import { EventHandlers } from './core/handlers.js';
import { LockManager } from './core/locks.js';
import { MergeWorker } from './core/merge-worker.js';
import { Scheduler } from './core/scheduler.js';
import { requeueMerge } from './core/state-machine.js';
import { openDatabase, type LeaderDb } from './db/repo.js';
import { LeaderGit } from './git/leader-git.js';
import type { Logger } from './logging.js';
import { NodeHub } from './ws/node-hub.js';
import { UiHub } from './ws/ui-hub.js';

export type { Logger } from './logging.js';

export interface LeaderHandle {
  /** Actual bound port (config may pass 0). */
  port: number;
  /** e.g. "ws://127.0.0.1:54321" */
  url: string;
  /** Stops scheduler, merge worker and servers; closes the DB. */
  close(): Promise<void>;
}

export interface StartLeaderOptions {
  logger?: Logger;
}

function openDb(dbPath: string): LeaderDb {
  if (dbPath !== ':memory:') mkdirSync(dirname(resolve(dbPath)), { recursive: true });
  return openDatabase(dbPath);
}

/** Leader-startup recovery (spec L9): everyone offline until hello; interrupted merges go back to the queue. */
function recover(db: LeaderDb, now: number): void {
  db.withTx(() => {
    for (const a of db.agents.find({ status: 'online' })) db.agents.update(a.id, { status: 'offline' });
    for (const t of db.tasks.find({ state: 'MERGING' })) requeueMerge(db, t.id, { reason: 'startup_recovery', actor: 'leader', at: now });
  });
}

export async function startLeader(config: LeaderConfig, options: StartLeaderOptions = {}): Promise<LeaderHandle> {
  const log: Logger = options.logger ?? pino({ level: process.env.QUORUM_LOG_LEVEL ?? 'warn', base: { component: 'leader' } });
  const db = openDb(config.dbPath);
  recover(db, Date.now());

  const git = new LeaderGit(config.repo, log);
  try {
    await git.ensureClone();
  } catch (error) {
    db.close();
    throw error;
  }

  // Late-bound references: the components call each other through callbacks.
  const late: { hub?: NodeHub; scheduler?: Scheduler; mergeWorker?: MergeWorker; ui?: UiHub } = {};

  const locks = new LockManager(db, {
    leaseSec: config.timeouts.leaseSec,
    deliver: (agentId, frame) => late.hub?.deliver(agentId, frame),
    onDeliveryError: (error) => log.warn({ err: error }, 'immediate delivery failed; outbox will retry'),
  });
  const handlers = new EventHandlers(db, config, locks, {
    onSessionOpened: (session, event, request) => late.scheduler?.sessionOpened(session, event, request),
    onChange: () => {
      late.scheduler?.trigger();
      late.mergeWorker?.kick();
    },
    onAttention: (taskId, reason, message) => late.ui?.attention(taskId, reason, message),
    onFinished: (task) => {
      if (config.repo.deleteBranchOnFinish && task.branch !== null) {
        const branch = task.branch;
        void git.exclusive(() => git.deleteRemoteBranch(branch)).catch((error: unknown) => log.warn({ err: error, branch }, 'branch cleanup failed'));
      }
    },
  });
  const scheduler = new Scheduler({
    db,
    config,
    locks,
    handlers,
    logger: log,
    idleThresholdSec: (agentId) => late.hub?.ownerSettings(agentId)?.idleThresholdSec,
    onAttention: (taskId, reason, message) => late.ui?.attention(taskId, reason, message),
  });
  late.scheduler = scheduler;
  const mergeWorker = new MergeWorker({ db, config, git, handlers, logger: log });
  late.mergeWorker = mergeWorker;
  const hub = new NodeHub(db, config, {
    locks,
    logger: log,
    onEvent: (agentId, event) => handlers.handle(agentId, event),
    onSessionLost: (session, reason) => handlers.sessionLost(session, reason),
    onStatusChanged: () => scheduler.trigger(),
  });
  late.hub = hub;
  const ui = new UiHub(db, config, (task) => scheduler.waitReason(task), Date.now, () => scheduler.queueSnapshot());
  late.ui = ui;
  hub.registerWebSocket('/ws/ui', ui.accept);
  registerRoutes(hub.server, { db, config, locks, handlers, scheduler, mergeWorker, git, logger: log });

  let address: { port: number; url: string };
  try {
    address = await hub.start();
  } catch (error) {
    db.close();
    throw error;
  }
  scheduler.start();
  mergeWorker.start();
  ui.start();
  log.info({ port: address.port, repo: config.repo.remoteUrl }, 'leader started');

  let closed = false;
  return {
    port: address.port,
    url: address.url,
    async close() {
      if (closed) return;
      closed = true;
      scheduler.stop();
      ui.stop();
      await mergeWorker.stop();
      await hub.close();
      db.close();
    },
  };
}

export function newAgentToken(): string {
  return `qrm_${randomBytes(32).toString('base64url')}`;
}

/** Registers an agent (or rotates its token and un-revokes it). Set rotate: false to protect an active token. */
export async function addAgent(dbPath: string, args: { id: string; owner: string; rotate?: boolean }): Promise<{ token: string }> {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(args.id)) throw new Error('agent id must be 1-64 characters of [A-Za-z0-9._-]');
  if (args.owner.trim() === '') throw new Error('owner is required');
  const db = openDb(dbPath);
  try {
    const token = newAgentToken();
    const hash = createHash('sha256').update(token).digest('hex');
    db.withTx(() => {
      const existing = db.agents.get(args.id);
      if (existing === undefined) {
        db.agents.insert({ id: args.id, owner_name: args.owner, token_hash: hash, created_at: Date.now() });
      } else {
        if (existing.revoked === 0 && args.rotate === false) {
          throw new Error(`Agent ${args.id} already exists. Pass --rotate to issue a new token (its current token and CLI tokens stop working), or pick another --id.`);
        }
        db.agents.update(args.id, { owner_name: args.owner, token_hash: hash, revoked: 0 });
        // Rotating an agent's token (re-inviting) also cuts off the API tokens minted with the old one.
        revokeAgentApiTokens(db, args.id, Date.now());
      }
    });
    return { token };
  } finally {
    db.close();
  }
}

export async function revokeAgent(dbPath: string, id: string): Promise<void> {
  const db = openDb(dbPath);
  try {
    db.withTx(() => {
      db.agents.update(id, { revoked: 1 });
      revokeAgentApiTokens(db, id, Date.now());
    });
  } finally {
    db.close();
  }
}

/** Mints a requester-scope API token for an existing agent (for the `quorum` CLI). Returns the plaintext once. */
export async function addApiToken(dbPath: string, args: { agentId: string; label?: string }): Promise<{ id: string; token: string }> {
  const db = openDb(dbPath);
  try {
    const agent = db.agents.get(args.agentId);
    if (agent === undefined || agent.revoked !== 0) throw new Error(`agent ${args.agentId} not found or revoked`);
    const { row, token } = mintApiToken(db, agent.id, args.label ?? '', Date.now());
    return { id: row.id, token };
  } finally {
    db.close();
  }
}

export async function listAgents(dbPath: string): Promise<{ id: string; owner: string; status: string; revoked: boolean; lastHeartbeatAt: number | null }[]> {
  const db = openDb(dbPath);
  try {
    return db.agents.all().map((a) => ({ id: a.id, owner: a.owner_name, status: a.status, revoked: a.revoked !== 0, lastHeartbeatAt: a.last_heartbeat_at }));
  } finally {
    db.close();
  }
}
