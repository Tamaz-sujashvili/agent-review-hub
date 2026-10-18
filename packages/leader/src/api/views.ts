import type {
  AgentView,
  ConversationView,
  DirectiveView,
  IssueView,
  MessageView,
  SessionView,
  TaskDetail,
  TaskEventView,
  TaskView,
  TeamActivityView,
  TaskWaitReason,
} from '@quorum/protocol';
import { budgetRemaining, lentToday } from '../core/budget.js';
import type {
  AgentRow,
  ConversationRow,
  DirectiveRow,
  IssueRow,
  LeaderDb,
  MessageRow,
  SessionRow,
  TaskEventRow,
  TaskRow,
} from '../db/repo.js';

// DB rows → protocol API views (camelCase, decoded JSON). Shapes are validated by API_ROUTES response schemas.

type V<T> = T;

export function agentView(db: LeaderDb, a: AgentRow, now: number, tz: string): AgentView {
  return {
    id: a.id,
    ownerName: a.owner_name,
    status: a.status as V<AgentView['status']>,
    lastHeartbeatAt: a.last_heartbeat_at,
    maxSessions: a.max_sessions,
    lendMode: a.lend_mode as V<AgentView['lendMode']>,
    lendTokensPerDay: a.lend_tokens_per_day,
    humanIdleSec: a.human_idle_sec,
    paused: a.paused !== 0,
    tags: JSON.parse(a.tags) as string[],
    contextWindow: a.context_window,
    rateLimitedUntil: a.rate_limited_until,
    lockedSessions: db.sessions.find({ agent_id: a.id, state: 'locked' }).length,
    idleSessions: db.sessions.find({ agent_id: a.id, state: 'idle' }).length,
    lentToday: lentToday(db, a.id, now, tz),
    budgetRemaining: budgetRemaining(db, a, now, tz),
  };
}

export function sessionView(s: SessionRow): SessionView {
  return {
    id: s.id,
    agentId: s.agent_id,
    state: s.state as V<SessionView['state']>,
    lockKind: s.lock_kind as V<SessionView['lockKind']>,
    lockRef: s.lock_ref,
    lockRole: s.lock_role as V<SessionView['lockRole']>,
    leaseExpiresAt: s.lease_expires_at,
    contextTokens: s.context_tokens,
    files: JSON.parse(s.files) as string[],
    taskHistory: JSON.parse(s.task_history) as number[],
    createdAt: s.created_at,
    lastUsedAt: s.last_used_at,
    closedAt: s.closed_at,
  };
}

export function taskView(db: LeaderDb, t: TaskRow, waitReason: TaskWaitReason | null = null): TaskView {
  return {
    id: t.id,
    title: t.title,
    description: t.description,
    tags: JSON.parse(t.tags) as string[],
    priority: t.priority,
    mode: t.mode as V<TaskView['mode']>,
    requesterAgentId: t.requester_agent_id,
    requesterOwner: db.agents.get(t.requester_agent_id)?.owner_name ?? t.requester_agent_id,
    authorAgentId: t.author_agent_id,
    authorSessionId: t.author_session_id,
    state: t.state as V<TaskView['state']>,
    waitReason,
    pausedFromState: t.paused_from_state as V<TaskView['pausedFromState']>,
    pauseReason: t.pause_reason,
    escalationReason: t.escalation_reason,
    branch: t.branch,
    baseCommit: t.base_commit,
    headCommit: t.head_commit,
    lastReviewedCommit: t.last_reviewed_commit,
    reviewRound: t.review_round,
    testFixAttempts: t.test_fix_attempts,
    syncAttempts: t.sync_attempts,
    files: JSON.parse(t.files) as string[],
    diffLines: t.diff_lines,
    lastTestOutput: t.last_test_output,
    mergedCommit: t.merged_commit,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
    stateEnteredAt: t.state_entered_at,
    approvedAt: t.approved_at,
  };
}

export function conversationView(c: ConversationRow): ConversationView {
  return {
    id: c.id,
    taskId: c.task_id,
    authorSessionId: c.author_session_id,
    authorAgentId: c.author_agent_id,
    reviewerSessionId: c.reviewer_session_id,
    reviewerAgentId: c.reviewer_agent_id,
    state: c.state as V<ConversationView['state']>,
    createdAt: c.created_at,
    endedAt: c.ended_at,
  };
}

export function issueView(i: IssueRow): IssueView {
  return {
    id: i.id,
    taskId: i.task_id,
    code: i.code,
    source: i.source as V<IssueView['source']>,
    severity: i.severity as V<IssueView['severity']>,
    file: i.file,
    line: i.line,
    comment: i.comment,
    status: i.status as V<IssueView['status']>,
    authorResponse: i.author_response as V<IssueView['authorResponse']>,
    authorNote: i.author_note,
    disputeCount: i.dispute_count,
    raisedRound: i.raised_round,
    conversationId: i.conversation_id,
    createdAt: i.created_at,
  };
}

export function taskEventView(e: TaskEventRow): TaskEventView {
  return {
    id: e.id,
    taskId: e.task_id,
    fromState: e.from_state as V<TaskEventView['fromState']>,
    toState: e.to_state as V<TaskEventView['toState']>,
    reason: e.reason,
    actor: e.actor,
    data: JSON.parse(e.data) as Record<string, unknown>,
    at: e.at,
  };
}

/** payload is the bare Command/Event, not the stored {kind,msgId,…} frame. */
export function messageView(m: MessageRow): MessageView {
  const frame = JSON.parse(m.payload) as { cmd?: unknown; evt?: unknown };
  return {
    id: m.id,
    direction: m.direction as V<MessageView['direction']>,
    agentId: m.agent_id,
    sessionId: m.session_id,
    taskId: m.task_id,
    directiveId: m.directive_id,
    conversationId: m.conversation_id,
    seq: m.seq,
    type: m.type,
    payload: frame.cmd ?? frame.evt ?? frame,
    createdAt: m.created_at,
    sentAt: m.sent_at,
    ackedAt: m.acked_at,
  };
}

export function directiveView(d: DirectiveRow): DirectiveView {
  return {
    id: d.id,
    requester: d.requester,
    agentId: d.agent_id,
    sessionId: d.session_id,
    text: d.text,
    state: d.state as V<DirectiveView['state']>,
    resultText: d.result_text,
    error: d.error,
    createdAt: d.created_at,
    finishedAt: d.finished_at,
  };
}

/** A privacy-safe, deterministic summary of every open session and agent without a session. */
export function teamActivity(db: LeaderDb, now: number): TeamActivityView[] {
  const agents = db.agents.all().filter((agent) => agent.revoked === 0);
  const sessions = db.sessions.all().filter((session) => session.state !== 'closed');
  const staleAfterMs = 30_000;
  const bySession = new Map(sessions.map((session) => [session.id, session]));
  const rows: TeamActivityView[] = [];

  for (const agent of agents) {
    const agentSessions = sessions.filter((session) => session.agent_id === agent.id);
    const visibleSessions = agentSessions.length === 0 ? [null] : agentSessions;
    for (const session of visibleSessions) {
      const taskId = session?.lock_kind === 'task' && session.lock_ref !== null ? Number(session.lock_ref) : null;
      const task = taskId !== null && Number.isSafeInteger(taskId) ? db.tasks.get(taskId) : undefined;
      const directive = session?.lock_kind === 'directive' && session.lock_ref !== null ? db.directives.get(session.lock_ref) : undefined;
      const role: TeamActivityView['role'] = session?.lock_kind === 'task'
        ? session.lock_role === 'author' || session.lock_role === 'reviewer' ? session.lock_role : 'idle'
        : session?.lock_kind === 'directive' ? 'directive' : 'idle';
      const conversation = task === undefined ? undefined : db.conversations.find({ task_id: task.id, state: 'active' }).find((c) =>
        c.author_session_id === session?.id || c.reviewer_session_id === session?.id,
      );
      const pairedSessionId = conversation === undefined ? null : conversation.author_session_id === session?.id
        ? conversation.reviewer_session_id
        : conversation.author_session_id;
      const pairedSession = pairedSessionId === null ? undefined : bySession.get(pairedSessionId);
      const pairedAgent = pairedSession === undefined ? undefined : db.agents.get(pairedSession.agent_id);
      let activityState: TeamActivityView['activityState'] = session === null || session.state === 'idle' ? 'idle' : 'waiting';
      let waitingOn: TeamActivityView['waitingOn'] = null;
      let waitingReason: string | null = null;
      const rateLimitedUntil = agent.rate_limited_until !== null && agent.rate_limited_until > now ? agent.rate_limited_until : null;
      if (agent.status !== 'online') activityState = 'offline';
      else if (agent.paused !== 0) activityState = 'paused';
      else if (rateLimitedUntil !== null && (session === null || session.state === 'idle')) { activityState = 'waiting'; waitingOn = 'rate_limit'; waitingReason = 'Rate-limited'; }
      else if (session?.state === 'opening') { activityState = 'waiting'; waitingOn = 'scheduler'; waitingReason = 'Starting session'; }
      else if (session?.state === 'lost' || session?.state === 'closing') { activityState = 'waiting'; waitingOn = 'scheduler'; waitingReason = session.state === 'lost' ? 'Session was lost' : 'Session is closing'; }
      else if (role === 'directive') {
        activityState = directive?.state === 'running' ? 'working' : 'waiting';
        if (activityState === 'waiting') { waitingOn = 'scheduler'; waitingReason = 'Directive is queued'; }
      } else if (task !== undefined) {
        if (task.state === 'PAUSED' && task.pause_reason === 'human') { activityState = 'paused'; waitingOn = 'human'; waitingReason = 'Paused by a human'; }
        // Other pauses (rate limit, lost author, …) resume on their own; the queue explains on what.
        else if (task.state === 'PAUSED') { activityState = 'paused'; waitingOn = 'scheduler'; waitingReason = `Paused: ${(task.pause_reason ?? 'unknown').replaceAll('_', ' ')}`; }
        else if (task.state === 'ESCALATED') { activityState = 'waiting'; waitingOn = 'human'; waitingReason = 'Needs a human decision'; }
        else if ((task.state === 'AUTHORING' || task.state === 'SYNCING') && role === 'author') activityState = 'working';
        else if (task.state === 'IN_REVIEW' && role === 'reviewer') activityState = 'working';
        else if (task.state === 'AWAITING_REVIEWER' && role === 'author') { activityState = 'waiting'; waitingOn = 'scheduler'; waitingReason = 'Waiting for a reviewer'; }
        else if (role === 'author' && task.state === 'IN_REVIEW') { activityState = 'waiting'; waitingOn = 'agent'; waitingReason = 'Waiting for reviewer'; }
        else if (role === 'reviewer' && (task.state === 'AUTHORING' || task.state === 'SYNCING') && pairedAgent !== undefined) { activityState = 'waiting'; waitingOn = 'agent'; waitingReason = 'Waiting for author fixes'; }
        else if (!['MERGED', 'CANCELLED', 'FAILED'].includes(task.state)) { activityState = 'waiting'; waitingOn = 'scheduler'; waitingReason = 'Waiting for task scheduler'; }
      }
      const stateChangedAt = agent.status !== 'online' || agent.paused !== 0
        ? agent.last_heartbeat_at ?? session?.last_used_at ?? now
        : task?.state_entered_at ?? directive?.created_at ?? session?.last_used_at ?? agent.last_heartbeat_at ?? now;
      rows.push({
        key: session?.id ?? `agent:${agent.id}`,
        agentId: agent.id,
        ownerName: agent.owner_name,
        agentStatus: agent.status as TeamActivityView['agentStatus'],
        sessionId: session?.id ?? null,
        sessionState: (session?.state as TeamActivityView['sessionState']) ?? null,
        role,
        activityState,
        waitingOn,
        waitingReason,
        waitingForName: waitingOn === 'agent'
          ? pairedAgent?.owner_name ?? null
          : waitingOn === 'human' && task !== undefined ? db.agents.get(task.requester_agent_id)?.owner_name ?? task.requester_agent_id : null,
        rateLimitedUntil,
        taskId: task?.id ?? null,
        taskTitle: task?.title ?? (directive === undefined ? null : 'Read-only question'),
        pairedAgentId: pairedAgent?.id ?? null,
        pairedOwnerName: pairedAgent?.owner_name ?? null,
        pairedSessionId: pairedSession?.id ?? null,
        stateChangedAt,
        lastHeartbeatAt: agent.last_heartbeat_at,
        stale: agent.status === 'online' && (agent.last_heartbeat_at === null || now - agent.last_heartbeat_at > staleAfterMs),
      });
    }
  }
  return rows.sort((a, b) => a.ownerName.localeCompare(b.ownerName) || a.agentId.localeCompare(b.agentId) || (a.sessionId ?? '').localeCompare(b.sessionId ?? ''));
}

export function taskDetail(db: LeaderDb, t: TaskRow, waitReason: TaskWaitReason | null = null): TaskDetail {
  return {
    task: taskView(db, t, waitReason),
    conversations: db.conversationsForTask(t.id).map(conversationView),
    issues: db.issues.find({ task_id: t.id }).map(issueView),
    events: db.taskEvents.find({ task_id: t.id }).map(taskEventView),
    messages: db.messagesForTask(t.id).map(messageView),
  };
}
