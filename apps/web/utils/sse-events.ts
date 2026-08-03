import type { ChatRouteDecision, ConversationToolCallSummary, ResumeVariant } from './resume';

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
  | 'agent.step.started'
  | 'agent.step.finished'
  | 'tool.call.started'
  | 'tool.call.finished'
  | 'assistant_chunk'
  | 'assistant_done'
  | 'done'
  | 'error';

interface ChatSseEventBase {
  spanId?: string;
  ts?: string;
}

interface ChatSseSpanEventBase extends ChatSseEventBase {
  parentSpanId?: string;
  name?: string;
  status?: string;
}

export interface ChatSseContextPackSummaryBlock {
  blockId: string;
  type: string;
  layer: string;
  position: number;
  title: string;
  content: string;
  memoryIds: string[];
  tokenEstimate: number;
  truncated: boolean;
  metadata?: Record<string, unknown>;
}

export interface ChatSseContextPackPayload {
  contextPackId?: string;
  selectedMemoryIds?: string[];
  droppedMemoryIds?: string[];
  summaryBlocks?: ChatSseContextPackSummaryBlock[];
  finalPromptPreview?: string;
}

export interface ChatSseDisplayPreferenceItem {
  category: string;
  key: string;
  normalizedValue: string;
  sourceKind: string;
  summary?: string | null;
  updatedAt: string;
}

export interface ChatSseStartEvent extends ChatSseEventBase, ChatSseContextPackPayload {
  event: 'start';
  requestId?: string;
  routeDecisionStarted?: boolean;
}

export interface ChatSseRouteDecisionEvent extends ChatSseEventBase, ChatSseContextPackPayload {
  event: 'route_decision';
  routeDecision: ChatRouteDecision;
}

export interface ChatSseAgentStepStartedEvent extends ChatSseSpanEventBase, ChatSseContextPackPayload {
  event: 'agent.step.started';
  agentRunId?: string;
  startedAt?: string;
  promptPreview?: string;
}

export interface ChatSseAgentStepFinishedEvent extends ChatSseSpanEventBase, ChatSseContextPackPayload {
  event: 'agent.step.finished';
  agentRunId?: string;
  startedAt?: string;
  finishedAt?: string;
  errorCode?: string;
  errorMessage?: string;
  promptPreview?: string;
}

export interface ChatSseToolStartEvent extends ChatSseSpanEventBase {
  event: 'tool_start' | 'tool.call.started';
  agentRunId?: string;
  toolName?: string;
  startedAt?: string;
}

export interface ChatSseToolDoneEvent extends ChatSseSpanEventBase {
  event: 'tool_done' | 'tool.call.finished';
  agentRunId?: string;
  toolName?: string;
  success?: boolean;
  latencyMs?: number;
  startedAt?: string;
  finishedAt?: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface ChatSseAssistantChunkEvent extends ChatSseSpanEventBase {
  event: 'assistant_chunk';
  text?: string;
}

export interface ChatSseAssistantDoneEvent extends ChatSseSpanEventBase, ChatSseContextPackPayload {
  event: 'assistant_done';
  content?: string;
  routeDecision?: ChatRouteDecision;
  toolCalls?: ConversationToolCallSummary[];
  displayPreferences?: ChatSseDisplayPreferenceItem[];
}

export interface ChatSseDoneEvent extends ChatSseEventBase, ChatSseContextPackPayload {
  event: 'done';
  conversationId?: string;
  agentRunId?: string;
  createdConversation?: boolean;
  routeDecision?: ChatRouteDecision;
  displayPreferences?: ChatSseDisplayPreferenceItem[];
}

export interface ChatSseErrorEvent extends ChatSseEventBase {
  event: 'error';
  code?: string;
  message?: string;
  requestId?: string;
}

export type ChatSseEvent =
  | ChatSseStartEvent
  | ChatSseRouteDecisionEvent
  | ChatSseAgentStepStartedEvent
  | ChatSseAgentStepFinishedEvent
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
  'agent.step.started': true,
  'agent.step.finished': true,
  'tool.call.started': true,
  'tool.call.finished': true,
  assistant_chunk: true,
  assistant_done: true,
  done: true,
  error: true,
};

export function isChatSseEventName(value: string): value is ChatSseEventName {
  return value in chatSseEventLookup;
}

export type SseEventRenderPhase = 'critical' | 'state' | 'bulk' | 'decorative' | 'unknown';

export function getResumeGenerateEventRenderPhase(eventName: ResumeGenerateEventName): SseEventRenderPhase {
  switch (eventName) {
    case 'done':
    case 'error':
    case 'canceled':
      return 'critical';
    case 'start':
    case 'progress':
      return 'state';
    case 'chunk':
      return 'bulk';
    default:
      return 'unknown';
  }
}

export function getChatSseEventRenderPhase(eventName: ChatSseEventName): SseEventRenderPhase {
  switch (eventName) {
    case 'done':
    case 'error':
    case 'assistant_done':
      return 'critical';
    case 'start':
    case 'route_decision':
    case 'agent.step.started':
    case 'agent.step.finished':
    case 'tool_start':
    case 'tool_done':
    case 'tool.call.started':
    case 'tool.call.finished':
      return 'state';
    case 'assistant_chunk':
      return 'bulk';
    default:
      return 'unknown';
  }
}
