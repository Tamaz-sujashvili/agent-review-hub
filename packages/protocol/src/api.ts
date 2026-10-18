import { z } from 'zod';
import { LendModeSchema } from './config.js';
import {
  AgentStatusSchema,
  AuthorActionSchema,
  ConversationStateSchema,
  DirectiveStateSchema,
  IssueSeveritySchema,
  IssueSourceSchema,
  IssueStatusSchema,
  LockKindSchema,
  LockRoleSchema,
  SessionStateSchema,
  TaskModeSchema,
  TaskPrioritySchema,
  TaskStateSchema,
} from './common.js';

// Leader REST API (/api/*) and UI WebSocket (/ws/ui) — spec §17.
// Views are camelCase projections of the §7 tables; JSON columns are decoded.

const ts = z.number().int();
const nullableTs = ts.nullable();

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export const AgentViewSchema = z.object({
  id: z.string(),
  ownerName: z.string(),
  status: AgentStatusSchema,
  lastHeartbeatAt: nullableTs,
  maxSessions: z.number().int(),
  lendMode: LendModeSchema,
  lendTokensPerDay: z.number().int(),
  humanIdleSec: z.number().nullable(),
  paused: z.boolean(),
  tags: z.array(z.string()),
  contextWindow: z.number().int(),
  rateLimitedUntil: nullableTs,
  lockedSessions: z.number().int(),
  idleSessions: z.number().int(),
  lentToday: z.number().int(),
  budgetRemaining: z.number().int(),
});
export type AgentView = z.infer<typeof AgentViewSchema>;

export const SessionViewSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  state: SessionStateSchema,
  lockKind: LockKindSchema.nullable(),
  lockRef: z.string().nullable(),
  lockRole: LockRoleSchema.nullable(),
  leaseExpiresAt: nullableTs,
  contextTokens: z.number().int(),
  files: z.array(z.string()),
  taskHistory: z.array(z.number().int()),
  createdAt: ts,
  lastUsedAt: ts,
  closedAt: nullableTs,
});
export type SessionView = z.infer<typeof SessionViewSchema>;

export const TaskWaitBlockerSchema = z.object({
  code: z.enum([
    'agent_offline',
    'agent_paused',
    'rate_limited',
    'session_capacity',
    'session_start_backoff',
    'lending_disabled',
    'owner_active',
    'budget_exhausted',
    'no_candidate_agent',
    'session_starting',
    'scheduler_pending',
  ]),
  agentCount: z.number().int().nonnegative(),
});
export type TaskWaitBlocker = z.infer<typeof TaskWaitBlockerSchema>;

export const TaskWaitReasonSchema = z.object({
  role: z.enum(['author', 'reviewer']),
  blockers: z.array(TaskWaitBlockerSchema),
});
export type TaskWaitReason = z.infer<typeof TaskWaitReasonSchema>;

export const TaskViewSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  description: z.string(),
  tags: z.array(z.string()),
  priority: TaskPrioritySchema,
  mode: TaskModeSchema,
  requesterAgentId: z.string(),
  requesterOwner: z.string(),
  authorAgentId: z.string().nullable(),
  authorSessionId: z.string().nullable(),
  state: TaskStateSchema,
  waitReason: TaskWaitReasonSchema.nullable().optional(),
  pausedFromState: TaskStateSchema.nullable(),
  pauseReason: z.string().nullable(),
  escalationReason: z.string().nullable(),
  branch: z.string().nullable(),
  baseCommit: z.string().nullable(),
  headCommit: z.string().nullable(),
  lastReviewedCommit: z.string().nullable(),
  reviewRound: z.number().int(),
  testFixAttempts: z.number().int(),
  syncAttempts: z.number().int(),
  files: z.array(z.string()),
  diffLines: z.number().int(),
  lastTestOutput: z.string().nullable(),
  mergedCommit: z.string().nullable(),
  createdAt: ts,
  updatedAt: ts,
  stateEnteredAt: ts,
  approvedAt: nullableTs,
});
export type TaskView = z.infer<typeof TaskViewSchema>;

export const ConversationViewSchema = z.object({
  id: z.string(),
  taskId: z.number().int(),
  authorSessionId: z.string(),
  authorAgentId: z.string(),
  reviewerSessionId: z.string(),
  reviewerAgentId: z.string(),
  state: ConversationStateSchema,
  createdAt: ts,
  endedAt: nullableTs,
});
export type ConversationView = z.infer<typeof ConversationViewSchema>;

export const IssueViewSchema = z.object({
  id: z.number().int(),
  taskId: z.number().int(),
  code: z.string(),
  source: IssueSourceSchema,
  severity: IssueSeveritySchema,
  file: z.string().nullable(),
  line: z.number().int().nullable(),
  comment: z.string(),
  status: IssueStatusSchema,
  authorResponse: AuthorActionSchema.nullable(),
  authorNote: z.string().nullable(),
  disputeCount: z.number().int(),
  raisedRound: z.number().int(),
  conversationId: z.string().nullable(),
  createdAt: ts,
});
export type IssueView = z.infer<typeof IssueViewSchema>;

export const TaskEventViewSchema = z.object({
  id: z.number().int(),
  taskId: z.number().int(),
  fromState: TaskStateSchema.nullable(),
  toState: TaskStateSchema,
  reason: z.string(),
  actor: z.string(),
  data: z.record(z.string(), z.unknown()),
  at: ts,
});
export type TaskEventView = z.infer<typeof TaskEventViewSchema>;

export const MessageViewSchema = z.object({
  id: z.string(),
  direction: z.enum(['to_node', 'from_node']),
  agentId: z.string(),
  sessionId: z.string().nullable(),
  taskId: z.number().int().nullable(),
  directiveId: z.string().nullable(),
  conversationId: z.string().nullable(),
  seq: z.number().int().nullable(),
  /** Command or event type, e.g. 'review.rereview'. */
  type: z.string(),
  /** The Command (to_node) or Event (from_node) object itself — not the {kind,msgId,…} frame. */
  payload: z.unknown(),
  createdAt: ts,
  sentAt: nullableTs,
  ackedAt: nullableTs,
});
export type MessageView = z.infer<typeof MessageViewSchema>;

export const TaskDetailSchema = z.object({
  task: TaskViewSchema,
  conversations: z.array(ConversationViewSchema),
  issues: z.array(IssueViewSchema),
  events: z.array(TaskEventViewSchema),
  messages: z.array(MessageViewSchema),
});
export type TaskDetail = z.infer<typeof TaskDetailSchema>;

export const DirectiveViewSchema = z.object({
  id: z.string(),
  requester: z.string(),
  agentId: z.string(),
  sessionId: z.string().nullable(),
  text: z.string(),
  state: DirectiveStateSchema,
  resultText: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: ts,
  finishedAt: nullableTs,
});
export type DirectiveView = z.infer<typeof DirectiveViewSchema>;

export const TeamActivityViewSchema = z.object({
  key: z.string(),
  agentId: z.string(),
  ownerName: z.string(),
  agentStatus: AgentStatusSchema,
  sessionId: z.string().nullable(),
  sessionState: SessionStateSchema.nullable(),
  role: z.enum(['author', 'reviewer', 'directive', 'idle']),
  activityState: z.enum(['working', 'waiting', 'paused', 'offline', 'idle']),
  waitingOn: z.enum(['agent', 'human', 'scheduler', 'rate_limit']).nullable(),
  waitingReason: z.string().nullable(),
  /** Who this row waits for: the paired agent's owner (waitingOn 'agent') or the requester (waitingOn 'human'). */
  waitingForName: z.string().nullable().default(null),
  rateLimitedUntil: nullableTs.default(null),
  taskId: z.number().int().nullable(),
  taskTitle: z.string().nullable(),
  pairedAgentId: z.string().nullable(),
  pairedOwnerName: z.string().nullable(),
  pairedSessionId: z.string().nullable(),
  stateChangedAt: ts,
  lastHeartbeatAt: nullableTs,
  stale: z.boolean(),
});
export type TeamActivityView = z.infer<typeof TeamActivityViewSchema>;

/** Why one agent cannot take a queued task right now (null = it could). */
export const QueueCandidateViewSchema = z.object({
  agentId: z.string(),
  ownerName: z.string(),
  blocker: z.string().nullable(),
});
export type QueueCandidateView = z.infer<typeof QueueCandidateViewSchema>;

/**
 * A task that waits for the scheduler, the merge worker or a human. `position` is the order one scheduler pass tries
 * tasks in (reviewers first, then authors, then merges); a blocked task does not hold back later ones. `position` is
 * null for tasks outside that order: human decisions and paused tasks. waitingOn 'scheduler' means the next pass acts on it.
 */
export const QueueEntryViewSchema = z.object({
  taskId: z.number().int(),
  title: z.string(),
  state: TaskStateSchema,
  position: z.number().int().positive().nullable(),
  needs: z.enum(['author', 'reviewer', 'merge', 'human']),
  requesterOwner: z.string(),
  authorOwnerName: z.string().nullable(),
  priority: z.number().int(),
  waitingSince: ts,
  waitingOn: z.enum(['agent', 'human', 'scheduler', 'rate_limit', 'merge']),
  reason: z.string(),
  candidates: z.array(QueueCandidateViewSchema),
});
export type QueueEntryView = z.infer<typeof QueueEntryViewSchema>;

// ---------------------------------------------------------------------------
// Requests / responses
// ---------------------------------------------------------------------------

export const ListAgentsResponseSchema = z.object({ agents: z.array(AgentViewSchema) });
export type ListAgentsResponse = z.infer<typeof ListAgentsResponseSchema>;

export const TeamActivityResponseSchema = z.object({
  activities: z.array(TeamActivityViewSchema),
  /** Older Leaders omit the queue. */
  queue: z.array(QueueEntryViewSchema).default([]),
});
export type TeamActivityResponse = z.infer<typeof TeamActivityResponseSchema>;

export const ListSessionsQuerySchema = z.object({ agentId: z.string().optional() });
export const ListSessionsResponseSchema = z.object({ sessions: z.array(SessionViewSchema) });
export type ListSessionsResponse = z.infer<typeof ListSessionsResponseSchema>;

export const ListTasksQuerySchema = z.object({
  state: TaskStateSchema.optional(),
  /** "true" → only tasks requested by the caller's agent. */
  mine: z.enum(['true', 'false']).optional(),
});
export const ListTasksResponseSchema = z.object({ tasks: z.array(TaskViewSchema) });
export type ListTasksResponse = z.infer<typeof ListTasksResponseSchema>;

export const CreateTaskRequestSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().min(1),
  tags: z.array(z.string()).default([]),
  priority: TaskPrioritySchema.default(1),
  mode: TaskModeSchema.default('own'),
});
export type CreateTaskRequest = z.input<typeof CreateTaskRequestSchema>;

export const PatchTaskRequestSchema = z
  .object({
    priority: TaskPrioritySchema.optional(),
    tags: z.array(z.string()).optional(),
    mode: TaskModeSchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'at least one field is required' });
export type PatchTaskRequest = z.infer<typeof PatchTaskRequestSchema>;

export const SendBackRequestSchema = z.object({ comment: z.string().min(1) });
export type SendBackRequest = z.infer<typeof SendBackRequestSchema>;

/** Answer to an author agent that is blocked on a question (task ESCALATED with author_blocked). */
export const AnswerTaskRequestSchema = z.object({ answer: z.string().min(1).max(20_000) });
export type AnswerTaskRequest = z.infer<typeof AnswerTaskRequestSchema>;

// ---------------------------------------------------------------------------
// API tokens: extra credentials an owner mints for scripts and coding agents (the `quorum` CLI)
// ---------------------------------------------------------------------------

/**
 * `full` is the agent's own token (desktop app, Node). `requester` tokens act as the same owner but may only
 * read, create tasks, answer a blocked author and ask agents: never approve, send back, cancel, pause,
 * reassign or mint tokens. They never authenticate a Node.
 */
export const TokenScopeSchema = z.enum(['full', 'requester']);
export type TokenScope = z.infer<typeof TokenScopeSchema>;

export const CreateApiTokenRequestSchema = z.object({ label: z.string().trim().max(80).optional() });
export type CreateApiTokenRequest = z.infer<typeof CreateApiTokenRequestSchema>;

export const ApiTokenViewSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  scope: z.literal('requester'),
  label: z.string(),
  createdAt: z.number().int(),
  lastUsedAt: z.number().int().nullable(),
  revokedAt: z.number().int().nullable(),
});
export type ApiTokenView = z.infer<typeof ApiTokenViewSchema>;

/** The plaintext token is returned exactly once, at creation. */
export const CreatedApiTokenSchema = ApiTokenViewSchema.extend({ token: z.string() });
export type CreatedApiToken = z.infer<typeof CreatedApiTokenSchema>;

export const ListApiTokensResponseSchema = z.object({ tokens: z.array(ApiTokenViewSchema) });
export type ListApiTokensResponse = z.infer<typeof ListApiTokensResponseSchema>;

export const DiffQuerySchema = z.object({ from: z.string().optional(), to: z.string().optional() });
export const DiffResponseSchema = z.object({ from: z.string(), to: z.string(), diff: z.string() });
export type DiffResponse = z.infer<typeof DiffResponseSchema>;

export const CreateDirectiveRequestSchema = z.object({
  agentId: z.string().min(1),
  text: z.string().min(1),
  sessionId: z.string().min(1).optional(),
});
export type CreateDirectiveRequest = z.infer<typeof CreateDirectiveRequestSchema>;

export const HealthResponseSchema = z.object({ ok: z.literal(true) });

export const ApiErrorCodeSchema = z.enum([
  'VALIDATION',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'ILLEGAL_TRANSITION',
  'SESSION_LOCKED',
  'CONFLICT',
  'INTERNAL',
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

export const ApiErrorSchema = z.object({ error: ApiErrorCodeSchema, message: z.string() });
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const API_ERROR_HTTP_STATUS: Record<ApiErrorCode, number> = {
  VALIDATION: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  ILLEGAL_TRANSITION: 409,
  SESSION_LOCKED: 409,
  CONFLICT: 409,
  INTERNAL: 500,
};

// ---------------------------------------------------------------------------
// Route table — the single source of truth for server (L8) and clients (desktop, e2e)
// ---------------------------------------------------------------------------

export type HttpMethod = 'GET' | 'POST' | 'PATCH';
export type RoutePermission = 'none' | 'any' | 'requesterOrAdmin';

export interface RouteDef {
  method: HttpMethod;
  /** Fastify-style path; `:id` is the task or directive id. */
  path: string;
  auth: RoutePermission;
  /** HTTP status on success. */
  status: 200 | 201;
  query?: z.ZodType;
  body?: z.ZodType;
  response: z.ZodType;
  /** True when a requester-scope API token may call this route (default: full tokens only). */
  requesterToken?: boolean;
}

const TaskActionBodySchema = z.object({}).strict().optional();

export const API_ROUTES = {
  health: { method: 'GET', path: '/api/health', auth: 'none', status: 200, response: HealthResponseSchema },
  listAgents: { method: 'GET', path: '/api/agents', auth: 'any', status: 200, response: ListAgentsResponseSchema, requesterToken: true },
  teamActivity: { method: 'GET', path: '/api/activity', auth: 'any', status: 200, response: TeamActivityResponseSchema },
  listSessions: {
    method: 'GET',
    path: '/api/sessions',
    auth: 'any',
    status: 200,
    query: ListSessionsQuerySchema,
    response: ListSessionsResponseSchema,
    requesterToken: true,
  },
  listTasks: { method: 'GET', path: '/api/tasks', auth: 'any', status: 200, query: ListTasksQuerySchema, response: ListTasksResponseSchema, requesterToken: true },
  createTask: { method: 'POST', path: '/api/tasks', auth: 'any', status: 201, body: CreateTaskRequestSchema, response: TaskViewSchema, requesterToken: true },
  getTask: { method: 'GET', path: '/api/tasks/:id', auth: 'any', status: 200, response: TaskDetailSchema, requesterToken: true },
  getTaskDiff: { method: 'GET', path: '/api/tasks/:id/diff', auth: 'any', status: 200, query: DiffQuerySchema, response: DiffResponseSchema, requesterToken: true },
  patchTask: { method: 'PATCH', path: '/api/tasks/:id', auth: 'requesterOrAdmin', status: 200, body: PatchTaskRequestSchema, response: TaskViewSchema },
  cancelTask: { method: 'POST', path: '/api/tasks/:id/cancel', auth: 'requesterOrAdmin', status: 200, body: TaskActionBodySchema, response: TaskViewSchema },
  approveTask: { method: 'POST', path: '/api/tasks/:id/approve', auth: 'requesterOrAdmin', status: 200, body: TaskActionBodySchema, response: TaskViewSchema },
  sendBackTask: { method: 'POST', path: '/api/tasks/:id/send-back', auth: 'requesterOrAdmin', status: 200, body: SendBackRequestSchema, response: TaskViewSchema },
  reassignReviewer: {
    method: 'POST',
    path: '/api/tasks/:id/reassign-reviewer',
    auth: 'requesterOrAdmin',
    status: 200,
    body: TaskActionBodySchema,
    response: TaskViewSchema,
  },
  pauseTask: { method: 'POST', path: '/api/tasks/:id/pause', auth: 'requesterOrAdmin', status: 200, body: TaskActionBodySchema, response: TaskViewSchema },
  resumeTask: { method: 'POST', path: '/api/tasks/:id/resume', auth: 'requesterOrAdmin', status: 200, body: TaskActionBodySchema, response: TaskViewSchema },
  createDirective: { method: 'POST', path: '/api/directives', auth: 'any', status: 201, body: CreateDirectiveRequestSchema, response: DirectiveViewSchema, requesterToken: true },
  getDirective: { method: 'GET', path: '/api/directives/:id', auth: 'any', status: 200, response: DirectiveViewSchema, requesterToken: true },
  answerTask: {
    method: 'POST',
    path: '/api/tasks/:id/answer',
    auth: 'requesterOrAdmin',
    status: 200,
    body: AnswerTaskRequestSchema,
    response: TaskViewSchema,
    requesterToken: true,
  },
  createApiToken: { method: 'POST', path: '/api/tokens', auth: 'any', status: 201, body: CreateApiTokenRequestSchema, response: CreatedApiTokenSchema },
  listApiTokens: { method: 'GET', path: '/api/tokens', auth: 'any', status: 200, response: ListApiTokensResponseSchema },
  revokeApiToken: { method: 'POST', path: '/api/tokens/:id/revoke', auth: 'any', status: 200, body: TaskActionBodySchema, response: ApiTokenViewSchema },
} as const satisfies Record<string, RouteDef>;

export type ApiRouteName = keyof typeof API_ROUTES;
export type ApiResponse<R extends ApiRouteName> = z.infer<(typeof API_ROUTES)[R]['response']>;

/** Fills `:id` in a route path. */
export function apiPath(route: ApiRouteName, id?: number | string): string {
  const path: string = API_ROUTES[route].path;
  if (!path.includes(':id')) return path;
  if (id === undefined) throw new Error(`route ${route} requires an id`);
  return path.replace(':id', encodeURIComponent(String(id)));
}

/** UI WebSocket path; authenticate with `?token=<agent token>`. */
export const UI_WS_PATH = '/ws/ui';
/** Node WebSocket path. */
export const NODE_WS_PATH = '/ws/node';

// ---------------------------------------------------------------------------
// UI WebSocket push events (/ws/ui)
// ---------------------------------------------------------------------------

export const NeedsAttentionReasonSchema = z.enum(['no_reviewer', 'author_unavailable', 'escalated']);

export const UiEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('task.updated'), data: TaskViewSchema }),
  z.object({ type: z.literal('task.event'), data: TaskEventViewSchema }),
  z.object({ type: z.literal('agent.updated'), data: AgentViewSchema }),
  z.object({ type: z.literal('team.activity.updated'), data: TeamActivityResponseSchema }),
  z.object({ type: z.literal('session.updated'), data: SessionViewSchema }),
  z.object({ type: z.literal('message.created'), data: MessageViewSchema }),
  z.object({ type: z.literal('directive.updated'), data: DirectiveViewSchema }),
  z.object({
    type: z.literal('task.needs_attention'),
    data: z.object({ taskId: z.number().int(), reason: NeedsAttentionReasonSchema, message: z.string() }),
  }),
]);
export type UiEvent = z.infer<typeof UiEventSchema>;
export type UiEventType = UiEvent['type'];
