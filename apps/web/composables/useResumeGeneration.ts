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
  isResumeGenerateEventName,
  type ResumeGenerateEvent,
} from '../utils/sse-events';
import { useSseMachine, type SseMachineStateSnapshot, type SseMachineStateValue } from './useSseMachine';

const API_BASE_URL = 'http://127.0.0.1:3001';

type FetchFn = typeof fetch;

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

const RESETTABLE_MACHINE_STATES = new Set<SseMachineStateValue>(['done', 'error', 'canceled']);
const CANCELABLE_MACHINE_STATES = new Set<SseMachineStateValue>(['connecting', 'streaming', 'paused']);

export function useResumeGeneration(options: UseResumeGenerationOptions) {
  const fetchFn = options.fetchFn ?? globalThis.fetch;

  const streamProgress = ref(0);
  const streamStage = ref('');
  const streamPreview = ref('');
  const resumeVariants = ref<ResumeVariant[]>([]);
  const selectedVariantIndex = ref(0);
  const lastGenerateQuery = ref('');

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

  const consumeSseStream = async (body: ReadableStream<Uint8Array>) => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const parseFrame = (frame: string) => {
      const lines = frame.split('\n');
      let eventName = '';
      const dataParts: string[] = [];

      for (const line of lines) {
        if (line.startsWith('event:')) {
          eventName = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          dataParts.push(line.slice(5).trim());
        }
      }

      if (!eventName || dataParts.length === 0) {
        return;
      }

      try {
        const payload = JSON.parse(dataParts.join('\n')) as Record<string, unknown>;
        if (!isResumeGenerateEventName(eventName)) {
          return;
        }

        handleStreamEvent({
          event: eventName,
          ...payload,
        } as ResumeGenerateEvent);
      } catch {
        // Ignore malformed SSE frames and continue consuming the stream.
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      if (!value) {
        continue;
      }

      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';

      for (const frame of frames) {
        parseFrame(frame);
      }
    }

    if (buffer.trim().length > 0) {
      parseFrame(buffer);
    }
  };

  const machine = useSseMachine({
    consumeResponse: async (response) => {
      if (response.status === 401) {
        options.clearAuth();
        throw new Error('登录状态已过期，请重新登录。');
      }

      if (!response.ok) {
        throw new Error(`濞翠礁绱￠悽鐔稿灇閹恒儱褰涙潻鏂挎礀瀵倸鐖堕敍娆籘TP ${response.status}`);
      }

      if (!response.body) {
        throw new Error('流式生成接口没有返回可读数据流。');
      }

      await consumeSseStream(response.body);

      if (resumeVariants.value.length > 0) {
        try {
          await options.seedGeneratedConversation();
          options.statusMessage.value = '简历已生成，并已写入会话，后续可以继续追问。';
        } catch (conversationError) {
          options.statusMessage.value =
            conversationError instanceof Error
              ? `缁犫偓閸樺棗鍑￠悽鐔稿灇閿涘奔绲鹃崘娆忓弳娴兼俺鐦芥径杈Е閿?{conversationError.message}`
              : '简历已生成，但写入会话失败。';
        }
      }
    },
  });
  const machineState = ref<SseMachineStateSnapshot>(machine.state);
  const generating = computed(() => {
    const state = machineState.value.value;
    return state === 'connecting' || state === 'streaming' || state === 'paused';
  });

  machine.onStateChange = (_, next) => {
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

    if (RESETTABLE_MACHINE_STATES.has(machine.state.value)) {
      machine.reset();
    }

    resetStreamState();

    try {
      await machine.connect(
        fetchFn(`${API_BASE_URL}/resume/generate/stream?${query}`, {
          method: 'GET',
          headers: {
            Accept: 'text/event-stream',
            Authorization: `Bearer ${options.token.value}`,
          },
          signal: machine.signal,
        }),
      );
    } catch (error) {
      if (machine.state.value !== 'canceled') {
        options.errorMessage.value = error instanceof Error ? error.message : '简历生成失败，请稍后重试。';
      }
    }
  };

  const generateResume = async () => {
    if (!generationReady.value) {
      options.errorMessage.value = '生成需要填写姓名、背景、目标岗位和至少一项技能；如果暂时不填，可以直接对话。';
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
    if (CANCELABLE_MACHINE_STATES.has(machine.state.value)) {
      machine.cancel();
    }
  };

  const dispose = () => {
    if (CANCELABLE_MACHINE_STATES.has(machine.state.value)) {
      machine.cancel();
    }
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
