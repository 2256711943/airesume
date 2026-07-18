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
import { consumeSseEventEnvelopeStream, SseStreamDisconnectedError } from '../utils/sse';
import { useSseSupervisor } from './useSseSupervisor';
import type { SseMachineStateSnapshot, SseMachineStateValue } from './useSseMachine';

const API_BASE_URL = 'http://127.0.0.1:3001';

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

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
const CANCELABLE_MACHINE_STATES = new Set<SseMachineStateValue>(['connecting', 'streaming', 'paused', 'retrying']);

export function useResumeGeneration(options: UseResumeGenerationOptions) {
  const fetchFn = options.fetchFn ?? globalThis.fetch;

  const streamProgress = ref(0);
  const streamStage = ref('');
  const streamPreview = ref('');
  const resumeVariants = ref<ResumeVariant[]>([]);
  const selectedVariantIndex = ref(0);
  const lastGenerateQuery = ref('');
  const lastEventSeq = ref(0);

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
        options.statusMessage.value = '绠€鍘嗗凡鐢熸垚锛屽苟宸插啓鍏ヤ細璇濓紝鍚庣画鍙互缁х画杩介棶銆?';
        break;
      case 'error': {
        const code = event.code ? `[${event.code}] ` : '';
        const message = event.message ?? '绠€鍘嗙敓鎴愬け璐ワ紝璇风◢鍚庨噸璇曘€?';
        options.errorMessage.value = `${code}${message}`;
        break;
      }
      case 'canceled':
        options.statusMessage.value = '鐢熸垚宸插彇娑堛€?';
        break;
    }
  };

  const supervisor = useSseSupervisor({
    consumeResponse: async (response) => {
      if (response.status === 401) {
        options.clearAuth();
        throw new Error('鐧诲綍鐘舵€佸凡杩囨湡锛岃閲嶆柊鐧诲綍銆?');
      }

      if (!response.ok) {
        throw new Error(`婵炵繝绀佺槐锟犳偨閻旂鐏囬柟鎭掑劚瑜版稒娼婚弬鎸庣鐎殿喖鍊搁悥鍫曟晬濞嗙睒TP ${response.status}`);
      }

      if (!response.body) {
        throw new Error('娴佸紡鐢熸垚鎺ュ彛娌℃湁杩斿洖鍙鏁版嵁娴併€?');
      }

      const result = await consumeSseEventEnvelopeStream(response.body, {
        lastSeq: lastEventSeq.value,
        isTerminalEvent: (type) => type === 'done' || type === 'error' || type === 'canceled',
        onEvent: (envelope) => {
          lastEventSeq.value = envelope.seq;
          if (!isResumeGenerateEventName(envelope.type)) {
            return;
          }

          handleStreamEvent({
            event: envelope.type,
            ...envelope.payload,
          } as ResumeGenerateEvent);
        },
      });

      lastEventSeq.value = result.lastSeq;

      if (resumeVariants.value.length > 0) {
        try {
          await options.seedGeneratedConversation();
          options.statusMessage.value = '绠€鍘嗗凡鐢熸垚锛屽苟宸插啓鍏ヤ細璇濓紝鍚庣画鍙互缁х画杩介棶銆?';
        } catch (conversationError) {
          options.statusMessage.value =
            conversationError instanceof Error
              ? `缂佺姭鍋撻柛妯烘閸戯繝鎮介悢绋跨亣闁挎稑濂旂徊楣冨礃濞嗗繐寮冲ù鍏间亢閻﹁姤寰勬潏顐バ曢柨?{conversationError.message}`
              : '绠€鍘嗗凡鐢熸垚锛屼絾鍐欏叆浼氳瘽澶辫触銆?';
        }
      }
    },
    maxRetries: 1,
    shouldRetry: (error, attempt) => {
      return attempt <= 1 && lastEventSeq.value === 0 && error instanceof SseStreamDisconnectedError;
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
      options.statusMessage.value = '鐢熸垚宸插彇娑堛€?';
    }
  };

  const startGenerateStream = async (query: string) => {
    if (!options.token.value) {
      options.errorMessage.value = '鐧诲綍鐘舵€佸凡澶辨晥锛岃閲嶆柊鐧诲綍銆?';
      return;
    }

    if (!fetchFn) {
      options.errorMessage.value = '褰撳墠鐜涓嶆敮鎸佹祦寮忕敓鎴愩€?';
      return;
    }

    if (RESETTABLE_MACHINE_STATES.has(supervisor.state.value)) {
      supervisor.reset();
    }

    resetStreamState();

    try {
      await supervisor.connect(({ signal }) =>
        fetchFn(`${API_BASE_URL}/resume/generate/stream?${query}`, {
          method: 'GET',
          headers: {
            Accept: 'text/event-stream',
            Authorization: `Bearer ${options.token.value}`,
          },
          signal,
        }),
      );
    } catch (error) {
      if (supervisor.state.value !== 'canceled') {
        options.errorMessage.value = error instanceof Error ? error.message : '绠€鍘嗙敓鎴愬け璐ワ紝璇风◢鍚庨噸璇曘€?';
      }
    }
  };

  const generateResume = async () => {
    if (!generationReady.value) {
      options.errorMessage.value = '鐢熸垚闇€瑕佸～鍐欏鍚嶃€佽儗鏅€佺洰鏍囧矖浣嶅拰鑷冲皯涓€椤规妧鑳斤紱濡傛灉鏆傛椂涓嶅～锛屽彲浠ョ洿鎺ュ璇濄€?';
      return;
    }

    lastGenerateQuery.value = buildGenerateQuery(options.form);
    await options.syncSystemContext();
    await startGenerateStream(lastGenerateQuery.value);
  };

  const retryGenerate = async () => {
    if (!lastGenerateQuery.value) {
      options.errorMessage.value = '褰撳墠娌℃湁鍙噸璇曠殑鐢熸垚璇锋眰銆?';
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
