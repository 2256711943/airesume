import type { ChatRouteDecision, ChatToolCallTrace, ResumeVariant } from './resume';

export type ResumeGenerateEventName = 'start' | 'progress' | 'chunk' | 'done' | 'error' | 'canceled';

export interface ResumeGenerateStartEvent {
  event: 'start';
  requestId?: string;
  taskId?: string;
  variantCount?: number;
  startedAt?: string;
  status?: string;
}

export interface ResumeGenerateProgressEvent {
  event: 'progress';
  requestId?: string;
  taskId?: string;
  progress?: number;
  stage?: string;
  timestamp?: string;
  status?: string;
}

export interface ResumeGenerateChunkEvent {
  event: 'chunk';
  requestId?: string;
  taskId?: string;
  variantIndex?: number;
  field?: string;
  text?: string;
  timestamp?: string;
  status?: string;
}

export interface ResumeGenerateDoneEvent {
  event: 'done';
  requestId?: string;
  taskId?: string;
  variantCount?: number;
  variants?: ResumeVariant[];
  finishedAt?: string;
  status?: string;
}

export interface ResumeGenerateErrorEvent {
  event: 'error';
  requestId?: string;
  taskId?: string;
  code?: string;
  message?: string;
  timestamp?: string;
  status?: string;
}

export interface ResumeGenerateCanceledEvent {
  event: 'canceled';
  requestId?: string;
  taskId?: string;
  reason?: string;
  timestamp?: string;
  status?: string;
}

export type ResumeGenerateEvent =
  | ResumeGenerateStartEvent
  | ResumeGenerateProgressEvent
  | ResumeGenerateChunkEvent
  | ResumeGenerateDoneEvent
  | ResumeGenerateErrorEvent
  | ResumeGenerateCanceledEvent;

const resumeGenerateEventLookup: Record<ResumeGenerateEventName, true> = {
  start: true,
  progress: true,
  chunk: true,
  done: true,
  error: true,
  canceled: true,
};

export function isResumeGenerateEventName(value: string): value is ResumeGenerateEventName {
  return value in resumeGenerateEventLookup;
}

export type ChatSseEventName =
  | 'start'
  | 'route_decision'
  | 'tool_start'
  | 'tool_done'
  | 'assistant_chunk'
  | 'assistant_done'
  | 'done'
  | 'error';

type ChatToolCallSummary = Pick<
  ChatToolCallTrace,
  'toolName' | 'success' | 'latencyMs' | 'errorCode' | 'errorMessage'
>;

export interface ChatSseStartEvent {
  event: 'start';
  requestId?: string;
  routeDecisionStarted?: boolean;
  ts?: string;
}

export interface ChatSseRouteDecisionEvent {
  event: 'route_decision';
  routeDecision: ChatRouteDecision;
  ts?: string;
}

export interface ChatSseToolStartEvent {
  event: 'tool_start';
  agentRunId?: string;
  toolName?: string;
  startedAt?: string;
  ts?: string;
}

export interface ChatSseToolDoneEvent {
  event: 'tool_done';
  agentRunId?: string;
  toolName?: string;
  success?: boolean;
  latencyMs?: number;
  errorCode?: string;
  errorMessage?: string;
  ts?: string;
}

export interface ChatSseAssistantChunkEvent {
  event: 'assistant_chunk';
  text?: string;
  ts?: string;
}

export interface ChatSseAssistantDoneEvent {
  event: 'assistant_done';
  content?: string;
  routeDecision?: ChatRouteDecision;
  toolCalls?: ChatToolCallSummary[];
  ts?: string;
}

export interface ChatSseDoneEvent {
  event: 'done';
  conversationId?: string;
  agentRunId?: string;
  createdConversation?: boolean;
  routeDecision?: ChatRouteDecision;
  ts?: string;
}

export interface ChatSseErrorEvent {
  event: 'error';
  code?: string;
  message?: string;
  requestId?: string;
  ts?: string;
}

export type ChatSseEvent =
  | ChatSseStartEvent
  | ChatSseRouteDecisionEvent
  | ChatSseToolStartEvent
  | ChatSseToolDoneEvent
  | ChatSseAssistantChunkEvent
  | ChatSseAssistantDoneEvent
  | ChatSseDoneEvent
  | ChatSseErrorEvent;

const chatSseEventLookup: Record<ChatSseEventName, true> = {
  start: true,
  route_decision: true,
  tool_start: true,
  tool_done: true,
  assistant_chunk: true,
  assistant_done: true,
  done: true,
  error: true,
};

export function isChatSseEventName(value: string): value is ChatSseEventName {
  return value in chatSseEventLookup;
}
