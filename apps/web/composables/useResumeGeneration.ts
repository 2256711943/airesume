import { computed, ref, type Ref } from 'vue';

import {
  buildGenerateQuery,
  buildVariantFileName,
  buildVariantMarkdown,
  getStreamStageLabel,
  getVariantLabel,
  isGenerationReady,
  parseVariants,
  type ResumeFormState,
  type ResumeVariant,
} from '../utils/resume';
import {
  getResumeGenerateEventRenderPhase,
  isResumeGenerateEventName,
  type ResumeGenerateEvent,
  type ResumeGenerateEventName,
} from '../utils/sse-events';
import {
  consumeSseEventEnvelopeStream,
  SseStreamDisconnectedError,
  type SseEventEnvelope,
} from '../utils/sse';
import {
  createTypewriterFrameSelector,
  useSseRenderEngine,
} from './useSseRenderEngine';
import { useSseSupervisor } from './useSseSupervisor';
import type { SseMachineStateSnapshot, SseMachineStateValue } from './useSseMachine';

const API_BASE_URL = 'http://127.0.0.1:3001';
const GENERATION_TYPEWRITER_CHARS_PER_SECOND = 120;

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;
type ResumeGenerateEnvelope = SseEventEnvelope<ResumeGenerateEventName>;

interface UseResumeGenerationOptions {
  form: ResumeFormState;
  token: Ref<string | null>;
  clearAuth: () => void;
  errorMessage: Ref<string>;
  statusMessage: Ref<string>;
  syncSystemContext: () => Promise<string>;
  seedGeneratedConversation: () => Promise<void>;
  fetchFn?: FetchFn;
}

interface ResumeRenderFrameItem {
  kind: 'event' | 'text';
  event: ResumeGenerateEvent;
}

const RESETTABLE_MACHINE_STATES = new Set<SseMachineStateValue>(['done', 'error', 'canceled']);
const CANCELABLE_MACHINE_STATES = new Set<SseMachineStateValue>(['connecting', 'streaming', 'paused', 'retrying']);

function createResumeStreamKey(): string {
  return `resume_stream_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function useResumeGeneration(options: UseResumeGenerationOptions) {
  const fetchFn = options.fetchFn ?? globalThis.fetch;

  const streamProgress = ref(0);
  const streamStage = ref('');
  const streamPreview = ref('');
  const resumeVariants = ref<ResumeVariant[]>([]);
  const selectedVariantIndex = ref(0);
  const lastGenerateQuery = ref('');
  const lastEventSeq = ref(0);
  const activeStreamKey = ref('');

  const selectedVariant = computed(() => resumeVariants.value[selectedVariantIndex.value] ?? null);
  const hasGeneratedVariants = computed(() => resumeVariants.value.length > 0);
  const activeVariantLabel = computed(() => getVariantLabel(selectedVariantIndex.value));
  const selectedVariantMarkdown = computed(() =>
    selectedVariant.value ? buildVariantMarkdown(selectedVariant.value, activeVariantLabel.value) : '',
  );
  const selectedVariantFileName = computed(() =>
    buildVariantFileName(options.form.targetRole, selectedVariantIndex.value),
  );
  const streamStageLabel = computed(() => getStreamStageLabel(streamStage.value));
  const generationReady = computed(() => isGenerationReady(options.form));

  const resetStreamState = () => {
    options.errorMessage.value = '';
    options.statusMessage.value = '';
    streamProgress.value = 0;
    streamStage.value = '';
    streamPreview.value = '';
    resumeVariants.value = [];
    selectedVariantIndex.value = 0;
    lastEventSeq.value = 0;
  };

  const handleStreamEvent = (event: ResumeGenerateEvent) => {
    switch (event.event) {
      case 'start':
        streamProgress.value = 0;
        streamStage.value = 'planning';
        break;
      case 'progress':
        streamProgress.value = Math.max(0, Math.min(100, Number(event.progress ?? 0)));
        streamStage.value = event.stage ?? streamStage.value;
        break;
      case 'chunk':
        if (event.text) {
          streamPreview.value += event.text;
        }
        break;
      case 'done':
        streamProgress.value = 100;
        streamStage.value = 'post_processing';
        resumeVariants.value = parseVariants(event.variants);
        selectedVariantIndex.value = 0;
        options.statusMessage.value = '简历已生成，并已写入会话，后续可以继续追问。';
        break;
      case 'error': {
        const code = event.code ? `[${event.code}] ` : '';
        const message = event.message ?? '简历生成失败，请稍后重试。';
        options.errorMessage.value = `${code}${message}`;
        break;
      }
      case 'canceled':
        options.statusMessage.value = '生成已取消。';
        break;
    }
  };

  const generationTypewriterSelector = createTypewriterFrameSelector<ResumeRenderFrameItem>({
    charsPerSecond: GENERATION_TYPEWRITER_CHARS_PER_SECOND,
    getText: async (item) => {
      return item.kind === 'text' ? item.event.text : null;
    },
    cloneWithText: async (item, text) => {
      return {
        ...item,
        event: {
          ...item.event,
          text,
        } as ResumeGenerateEvent,
      };
    },
    isTerminalItem: async (item) => {
      return item.kind === 'event' && (
        item.event.event === 'error' ||
        item.event.event === 'canceled'
      );
    },
  });

  const mergeResumeRenderFrameItems = async (previous: ResumeRenderFrameItem, next: ResumeRenderFrameItem) => {
    if (
      previous.kind !== 'text' ||
      next.kind !== 'text' ||
      previous.event.event !== 'chunk' ||
      next.event.event !== 'chunk' ||
      previous.event.requestId !== next.event.requestId ||
      previous.event.taskId !== next.event.taskId ||
      previous.event.variantIndex !== next.event.variantIndex ||
      previous.event.field !== next.event.field
    ) {
      return undefined;
    }

    return {
      ...previous,
      event: {
        ...next.event,
        text: `${previous.event.text ?? ''}${next.event.text ?? ''}`,
      } as ResumeGenerateEvent,
    } satisfies ResumeRenderFrameItem;
  };

  const resumeRenderEngine = useSseRenderEngine<ResumeGenerateEnvelope, ResumeRenderFrameItem>({
    classifyIngressPhase: async (item) => getResumeGenerateEventRenderPhase(item.type),
    transformIngress: async (item) => {
      const event = {
        event: item.type,
        ...item.payload,
      } as ResumeGenerateEvent;

      if (event.event === 'chunk' && typeof event.text === 'string' && event.text.length > 0) {
        return [{
          kind: 'text',
          event,
        }];
      }

      return [{
        kind: 'event',
        event,
      }];
    },
    mergeFrameItems: mergeResumeRenderFrameItems,
    selectFrameItems: generationTypewriterSelector.selectFrameItems,
    commitFrame: async (items) => {
      for (const item of items) {
        handleStreamEvent(item.event);
      }
    },
    onError: async (error) => {
      options.errorMessage.value =
        error instanceof Error ? error.message : '简历渲染失败，请稍后重试。';
    },
  });

  const supervisor = useSseSupervisor({
    consumeResponse: async (response) => {
      if (response.status === 401) {
        options.clearAuth();
        throw new Error('登录状态已过期，请重新登录。');
      }

      if (!response.ok) {
        throw new Error(`简历生成接口返回 HTTP ${response.status}`);
      }

      if (!response.body) {
        throw new Error('流式生成接口没有返回可读数据流。');
      }

      await generationTypewriterSelector.reset();
      await resumeRenderEngine.dispose();
      await resumeRenderEngine.start();

      let enqueueRenderTask = Promise.resolve();
      const result = await consumeSseEventEnvelopeStream(response.body, {
        lastSeq: lastEventSeq.value,
        isTerminalEvent: (type) => type === 'done' || type === 'error' || type === 'canceled',
        onEvent: (envelope) => {
          lastEventSeq.value = envelope.seq;
          if (!isResumeGenerateEventName(envelope.type)) {
            return;
          }

          enqueueRenderTask = enqueueRenderTask.then(async () => {
            await resumeRenderEngine.enqueueIngress(envelope as ResumeGenerateEnvelope);
          });
        },
      });

      await enqueueRenderTask;
      await resumeRenderEngine.flush();
      lastEventSeq.value = result.lastSeq;

      if (resumeVariants.value.length > 0) {
        try {
          await options.seedGeneratedConversation();
          options.statusMessage.value = '简历已生成，并已写入会话，后续可以继续追问。';
        } catch (conversationError) {
          options.statusMessage.value =
            conversationError instanceof Error
              ? `写入会话失败：${conversationError.message}`
              : '简历已生成，但写入会话失败。';
        }
      }
    },
    maxRetries: 1,
    shouldRetry: (error, attempt) => {
      return attempt <= 1 && error instanceof SseStreamDisconnectedError;
    },
  });

  const machineState = ref<SseMachineStateSnapshot>(supervisor.state);
  const generating = computed(() => {
    const state = machineState.value.value;
    return state === 'connecting' || state === 'streaming' || state === 'paused' || state === 'retrying';
  });

  supervisor.onStateChange = (_, next) => {
    machineState.value = next;

    if (next.value === 'canceled') {
      options.statusMessage.value = '生成已取消。';
    }
  };

  const startGenerateStream = async (query: string) => {
    if (!options.token.value) {
      options.errorMessage.value = '登录状态已失效，请重新登录。';
      return;
    }

    if (!fetchFn) {
      options.errorMessage.value = '当前环境不支持流式生成。';
      return;
    }

    if (RESETTABLE_MACHINE_STATES.has(supervisor.state.value)) {
      supervisor.reset();
    }

    activeStreamKey.value = createResumeStreamKey();
    resetStreamState();

    try {
      await supervisor.connect(({ signal }) => {
        const params = new URLSearchParams(query);
        params.set('streamKey', activeStreamKey.value);
        params.set('sinceSeq', String(lastEventSeq.value));

        return fetchFn(`${API_BASE_URL}/resume/generate/stream?${params.toString()}`, {
          method: 'GET',
          headers: {
            Accept: 'text/event-stream',
            Authorization: `Bearer ${options.token.value}`,
          },
          signal,
        });
      });
    } catch (error) {
      if (supervisor.state.value !== 'canceled') {
        options.errorMessage.value = error instanceof Error ? error.message : '简历生成失败，请稍后重试。';
      }
    }
  };

  const generateResume = async () => {
    if (!generationReady.value) {
      options.errorMessage.value = '生成需要填写姓名、背景、目标岗位和至少一项技能；如果暂时不填，也可以直接对话。';
      return;
    }

    lastGenerateQuery.value = buildGenerateQuery(options.form);
    await options.syncSystemContext();
    await startGenerateStream(lastGenerateQuery.value);
  };

  const retryGenerate = async () => {
    if (!lastGenerateQuery.value) {
      options.errorMessage.value = '当前没有可重试的生成请求。';
      return;
    }

    await options.syncSystemContext();
    await startGenerateStream(lastGenerateQuery.value);
  };

  const cancelGenerate = () => {
    if (CANCELABLE_MACHINE_STATES.has(supervisor.state.value)) {
      supervisor.cancel();
    }
  };

  const dispose = () => {
    if (CANCELABLE_MACHINE_STATES.has(supervisor.state.value)) {
      supervisor.cancel();
    }

    void resumeRenderEngine.dispose();
    void generationTypewriterSelector.reset();
  };

  return {
    activeVariantLabel,
    cancelGenerate,
    dispose,
    generateResume,
    generating,
    generationReady,
    hasGeneratedVariants,
    lastGenerateQuery,
    resumeVariants,
    retryGenerate,
    resumeRenderMonitoring: resumeRenderEngine.monitoring,
    selectedVariant,
    selectedVariantFileName,
    selectedVariantIndex,
    selectedVariantMarkdown,
    streamPreview,
    streamProgress,
    streamStage,
    streamStageLabel,
  };
}
