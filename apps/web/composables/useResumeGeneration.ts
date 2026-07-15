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
  type StreamChunkPayload,
  type StreamDonePayload,
  type StreamErrorPayload,
  type StreamProgressPayload,
} from '../utils/resume';

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

export function useResumeGeneration(options: UseResumeGenerationOptions) {
  const fetchFn = options.fetchFn ?? globalThis.fetch;

  const generating = ref(false);
  const streamProgress = ref(0);
  const streamStage = ref('');
  const streamPreview = ref('');
  const resumeVariants = ref<ResumeVariant[]>([]);
  const selectedVariantIndex = ref(0);
  const currentStreamController = ref<AbortController | null>(null);
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

  const handleStreamEvent = (eventName: string, payload: Record<string, unknown>) => {
    const event = eventName as 'start' | 'progress' | 'chunk' | 'done' | 'error' | 'canceled';

    if (event === 'start') {
      streamProgress.value = 0;
      streamStage.value = 'planning';
      return;
    }

    if (event === 'progress') {
      const progressPayload = payload as StreamProgressPayload;
      streamProgress.value = Math.max(0, Math.min(100, Number(progressPayload.progress ?? 0)));
      streamStage.value = typeof progressPayload.stage === 'string' ? progressPayload.stage : streamStage.value;
      return;
    }

    if (event === 'chunk') {
      const chunkPayload = payload as StreamChunkPayload;
      if (typeof chunkPayload.text === 'string') {
        streamPreview.value += chunkPayload.text;
      }
      return;
    }

    if (event === 'done') {
      const donePayload = payload as StreamDonePayload;
      streamProgress.value = 100;
      streamStage.value = 'post_processing';
      resumeVariants.value = parseVariants(donePayload.variants);
      selectedVariantIndex.value = 0;
      options.statusMessage.value = '简历已生成完成。';
      return;
    }

    if (event === 'error') {
      const errorPayload = payload as StreamErrorPayload;
      const code = typeof errorPayload.code === 'string' ? `[${errorPayload.code}] ` : '';
      const message = typeof errorPayload.message === 'string' ? errorPayload.message : '简历生成失败，请稍后重试。';
      options.errorMessage.value = `${code}${message}`;
      return;
    }

    if (event === 'canceled') {
      options.statusMessage.value = '生成已取消。';
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
        handleStreamEvent(eventName, payload);
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

  const startGenerateStream = async (query: string) => {
    if (!options.token.value) {
      options.errorMessage.value = '登录状态已失效，请重新登录。';
      return;
    }

    if (!fetchFn) {
      options.errorMessage.value = '当前环境不支持流式生成。';
      return;
    }

    generating.value = true;
    resetStreamState();

    const controller = new AbortController();
    currentStreamController.value = controller;

    try {
      const response = await fetchFn(`${API_BASE_URL}/resume/generate/stream?${query}`, {
        method: 'GET',
        headers: {
          Accept: 'text/event-stream',
          Authorization: `Bearer ${options.token.value}`,
        },
        signal: controller.signal,
      });

      if (response.status === 401) {
        options.clearAuth();
        throw new Error('登录状态已过期，请重新登录。');
      }

      if (!response.ok) {
        throw new Error(`流式生成接口返回异常：HTTP ${response.status}`);
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
              ? `简历已生成，但写入会话失败：${conversationError.message}`
              : '简历已生成，但写入会话失败。';
        }
      }
    } catch (error) {
      if (controller.signal.aborted) {
        options.statusMessage.value = '生成已取消。';
      } else {
        options.errorMessage.value = error instanceof Error ? error.message : '简历生成失败，请稍后重试。';
      }
    } finally {
      generating.value = false;
      currentStreamController.value = null;
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
    currentStreamController.value?.abort();
  };

  const dispose = () => {
    currentStreamController.value?.abort();
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
