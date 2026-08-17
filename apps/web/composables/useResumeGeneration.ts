import { computed, ref, type Ref } from "vue";

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
} from "../utils/resume";
import { API_BASE_URL } from "../utils/api";
import {
  getResumeGenerateEventRenderPhase,
  isResumeGenerateEventName,
  type ResumeGenerateEvent,
  type ResumeGenerateEventName,
} from "../utils/sse-events";
import {
  consumeSseEventEnvelopeStream,
  SseStreamDisconnectedError,
  type SseEventEnvelope,
} from "../utils/sse";
import {
  createTypewriterFrameSelector,
  useSseRenderEngine,
} from "./useSseRenderEngine";
import { useSseSupervisor } from "./useSseSupervisor";
import type {
  SseMachineStateSnapshot,
  SseMachineStateValue,
} from "./useSseMachine";
/**
 * 简历生成组合式函数（useResumeGeneration）
 *
 * 负责「简历 SSE 流式生成」的完整前端编排：
 * 1. 构造 /resume/generate/stream 请求，通过 SseSupervisor 建立连接（含断线重连）；
 * 2. 将收到的 SSE 事件送入 useSseRenderEngine 渲染引擎，实现打字机效果的增量展示；
 * 3. 维护流式进度、阶段、预览文本与最终生成的简历变体列表；
 * 4. 生成成功后回调 seedGeneratedConversation 将结果写入会话。
 */
const GENERATION_TYPEWRITER_CHARS_PER_SECOND = 120;

/** fetch 实现类型，便于测试时注入 mock。 */
type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;
/** 简历生成 SSE 事件信封（type 为事件名，payload 为事件内容）。 */
type ResumeGenerateEnvelope = SseEventEnvelope<ResumeGenerateEventName>;

interface UseResumeGenerationOptions {
  /** 简历表单状态（姓名、背景、技能、目标岗位等）。 */
  form: ResumeFormState;
  /** 登录令牌（ref，读取最新值）。 */
  token: Ref<string | null>;
  /** 登录失效时清理认证状态。 */
  clearAuth: () => void;
  /** 错误提示信息（写回外部 ref）。 */
  errorMessage: Ref<string>;
  /** 状态提示信息（写回外部 ref）。 */
  statusMessage: Ref<string>;
  /** 生成前同步系统上下文（返回会话上下文文本）。 */
 syncSystemContext: () => Promise<string>;
  /** 生成成功后把结果写入会话，供后续追问。 */
  seedGeneratedConversation: () => Promise<void>;
  /** 可选的自定义 fetch 实现（默认 globalThis.fetch）。 */
  fetchFn?: FetchFn;
}

/** 渲染引擎的帧条目：事件帧（一次性）或文本帧（打字机增量）。 */
interface ResumeRenderFrameItem {
  kind: "event" | "text";
  event: ResumeGenerateEvent;
}

/** 处于这些状态时，发起新一轮生成前需要先 reset 状态机。 */
const RESETTABLE_MACHINE_STATES = new Set<SseMachineStateValue>([
  "done",
  "error",
  "canceled",
]);
/** 处于这些状态时，允许执行取消操作。 */
const CANCELABLE_MACHINE_STATES = new Set<SseMachineStateValue>([
  "connecting",
  "streaming",
  "paused",
  "retrying",
]);

/** 生成一个全局唯一的流标识，用于服务端会话回放/重连。 */
function createResumeStreamKey(): string {
  return `resume_stream_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function useResumeGeneration(options: UseResumeGenerationOptions) {
  const fetchFn = options.fetchFn ?? globalThis.fetch;

  // ---- 流式生成状态 ----
  /** 生成进度（0-100）。 */
  const streamProgress = ref(0);
  /** 当前生成阶段（planning/generating/post_processing 等）。 */
  const streamStage = ref("");
  /** 流式预览文本（chunk 增量拼接）。 */
  const streamPreview = ref("");
  /** 最终解析出的简历变体列表。 */
  const resumeVariants = ref<ResumeVariant[]>([]);
  /** 当前选中的变体下标。 */
  const selectedVariantIndex = ref(0);
  /** 最近一次生成请求的查询串（供重试使用）。 */
  const lastGenerateQuery = ref("");
  /** 已消费的 SSE 事件序号（断线重连时用于续传）。 */
  const lastEventSeq = ref(0);
  /** 当前活跃的流标识。 */
  const activeStreamKey = ref("");

  // ---- 派生状态 ----
  /** 当前选中的变体对象。 */
  const selectedVariant = computed(
    () => resumeVariants.value[selectedVariantIndex.value] ?? null,
  );
  /** 是否已生成出至少一个变体。 */
  const hasGeneratedVariants = computed(() => resumeVariants.value.length > 0);
  /** 当前选中变体的展示标签（如「技术向」「商务向」「综合向」）。 */
  const activeVariantLabel = computed(() =>
    getVariantLabel(selectedVariantIndex.value),
  );
  /** 当前选中变体的 Markdown 全文。 */
  const selectedVariantMarkdown = computed(() =>
    selectedVariant.value
      ? buildVariantMarkdown(selectedVariant.value, activeVariantLabel.value)
      : "",
  );
  /** 当前选中变体的导出文件名。 */
  const selectedVariantFileName = computed(() =>
    buildVariantFileName(options.form.targetRole, selectedVariantIndex.value),
  );
  /** 流式阶段的展示文案。 */
  const streamStageLabel = computed(() =>
    getStreamStageLabel(streamStage.value),
  );
  /** 表单是否满足生成前置条件。 */
  const generationReady = computed(() => isGenerationReady(options.form));

  /** 清空上一次生成残留的所有状态，准备新一轮生成。 */
  const resetStreamState = () => {
    options.errorMessage.value = "";
    options.statusMessage.value = "";
    streamProgress.value = 0;
    streamStage.value = "";
    streamPreview.value = "";
    resumeVariants.value = [];
    selectedVariantIndex.value = 0;
    lastEventSeq.value = 0;
  };

  /** 按事件类型更新流式生成的相关状态。 */
  const handleStreamEvent = (event: ResumeGenerateEvent) => {
    switch (event.event) {
      case "start":
        streamProgress.value = 0;
        streamStage.value = "planning";
        break;
      case "progress":
        streamProgress.value = Math.max(
          0,
          Math.min(100, Number(event.progress ?? 0)),
        );
        streamStage.value = event.stage ?? streamStage.value;
        break;
      case "chunk":
        if (event.text) {
          streamPreview.value += event.text;
        }
        break;
      case "done":
        streamProgress.value = 100;
        streamStage.value = "post_processing";
        resumeVariants.value = parseVariants(event.variants);
        selectedVariantIndex.value = 0;
        options.statusMessage.value =
          "简历已生成，并已写入会话，后续可以继续追问。";
        break;
      case "error": {
        const code = event.code ? `[${event.code}] ` : "";
        const message = event.message ?? "简历生成失败，请稍后重试。";
        options.errorMessage.value = `${code}${message}`;
        break;
      }
      case "canceled":
        options.statusMessage.value = "生成已取消。";
        break;
    }
  };

  /** 打字机帧选择器：以固定速度把文本帧拆分为可逐步提交的帧序列。 */
  const generationTypewriterSelector =
    createTypewriterFrameSelector<ResumeRenderFrameItem>({
      charsPerSecond: GENERATION_TYPEWRITER_CHARS_PER_SECOND,
      /** 仅文本帧（chunk）参与打字机逐字展开。 */
      getText: async (item) => {
        return item.kind === "text" && "text" in item.event
          ? (item.event.text ?? null)
          : null;
      },
      /** 复制帧并替换其中的文本（用于生成“已展示到第 N 个字”的帧）。 */
      cloneWithText: async (item, text) => {
        return {
          ...item,
          event: {
            ...item.event,
            text,
          } as ResumeGenerateEvent,
        };
      },
      /** 错误/取消事件为终止帧，后续不再有内容。 */
      isTerminalItem: async (item) => {
        return (
          item.kind === "event" &&
          (item.event.event === "error" || item.event.event === "canceled")
        );
      },
    });

  /**
   * 合并相邻的文本帧：属于同一请求/任务/变体/字段的连续 chunk 会拼接为一段，
   * 避免打字机渲染时把一段文字拆成太多帧。
   */
  const mergeResumeRenderFrameItems = async (
    previous: ResumeRenderFrameItem,
    next: ResumeRenderFrameItem,
  ) => {
    if (
      previous.kind !== "text" ||
      next.kind !== "text" ||
      previous.event.event !== "chunk" ||
      next.event.event !== "chunk" ||
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
        text: `${previous.event.text ?? ""}${next.event.text ?? ""}`,
      } as ResumeGenerateEvent,
    } satisfies ResumeRenderFrameItem;
  };

  /**
   * 简历渲染引擎：把 SSE 事件转成渲染帧，经过打字机/合并处理后提交到 UI。
   */
  const resumeRenderEngine = useSseRenderEngine<
    ResumeGenerateEnvelope,
    ResumeRenderFrameItem
  >({
    /** 按事件类型划分渲染阶段（决定帧的提交时机）。 */
    classifyIngressPhase: async (item) =>
      getResumeGenerateEventRenderPhase(item.type),
    /** 入站事件 -> 渲染帧：chunk 转文本帧，其余事件转事件帧。 */
    transformIngress: async (item) => {
      const event = {
        event: item.type,
        ...item.payload,
      } as ResumeGenerateEvent;

      if (
        event.event === "chunk" &&
        typeof event.text === "string" &&
        event.text.length > 0
      ) {
        return [
          {
            kind: "text",
            event,
          },
        ];
      }

      return [
        {
          kind: "event",
          event,
        },
      ];
    },
    mergeFrameItems: mergeResumeRenderFrameItems,
    selectFrameItems: generationTypewriterSelector.selectFrameItems,
    /** 提交一帧：驱动简历相关状态更新。 */
    commitFrame: async (items) => {
      for (const item of items) {
        handleStreamEvent(item.event);
      }
    },
    /** 渲染管线异常兜底。 */
    onError: async (error) => {
      options.errorMessage.value =
        error instanceof Error ? error.message : "简历渲染失败，请稍后重试。";
    },
  });

  /**
   * SSE 监督器：消费响应流，并对断流（SseStreamDisconnectedError）做一次重连。
   */
  const supervisor = useSseSupervisor({
    consumeResponse: async (response) => {
      // 登录失效：清理认证并终止
      if (response.status === 401) {
        options.clearAuth();
        throw new Error("登录状态已过期，请重新登录。");
      }

      if (!response.ok) {
        throw new Error(`简历生成接口返回 HTTP ${response.status}`);
      }

      if (!response.body) {
        throw new Error("流式生成接口没有返回可读数据流。");
      }

      // 每轮连接都重新初始化渲染引擎与打字机选择器
      await generationTypewriterSelector.reset();
      await resumeRenderEngine.dispose();
      await resumeRenderEngine.start();

      // 串行入队渲染任务，保证事件处理顺序与 seq 一致
      let enqueueRenderTask = Promise.resolve();
      const result = await consumeSseEventEnvelopeStream(response.body, {
        lastSeq: lastEventSeq.value,
        isTerminalEvent: (type) =>
          type === "done" || type === "error" || type === "canceled",
        onEvent: (envelope) => {
          lastEventSeq.value = envelope.seq;
          if (!isResumeGenerateEventName(envelope.type)) {
            return;
          }

          enqueueRenderTask = enqueueRenderTask.then(async () => {
            await resumeRenderEngine.enqueueIngress(
              envelope as ResumeGenerateEnvelope,
            );
          });
        },
      });

      await enqueueRenderTask;
      await resumeRenderEngine.flush();
      lastEventSeq.value = result.lastSeq;

      // 生成成功且有变体时，把结果写入会话以便继续追问
      if (resumeVariants.value.length > 0) {
        try {
          await options.seedGeneratedConversation();
          options.statusMessage.value =
            "简历已生成，并已写入会话，后续可以继续追问。";
        } catch (conversationError) {
          options.statusMessage.value =
            conversationError instanceof Error
              ? `写入会话失败：${conversationError.message}`
              : "简历已生成，但写入会话失败。";
        }
      }
    },
    // 最多重试 1 次，且仅针对「流中断」类错误
    maxRetries: 1,
    shouldRetry: (error, attempt) => {
      return attempt <= 1 && error instanceof SseStreamDisconnectedError;
    },
  });

  /** 状态机快照的响应式镜像，驱动 generating 计算属性。 */
  const machineState = ref<SseMachineStateSnapshot>(supervisor.state);
  /** 是否正在生成（连接/流式/暂停/重试中）。 */
  const generating = computed(() => {
    const state = machineState.value.value;
    return (
      state === "connecting" ||
      state === "streaming" ||
      state === "paused" ||
      state === "retrying"
    );
  });

  // 同步状态机迁移到响应式状态，并处理取消提示
  supervisor.onStateChange = (_, next) => {
    machineState.value = next;

    if (next.value === "canceled") {
      options.statusMessage.value = "生成已取消。";
    }
  };

  /**
   * 发起一次简历流式生成：
   * 构造带 streamKey / sinceSeq 的 GET 请求并通过 supervisor 连接。
   */
  const startGenerateStream = async (query: string) => {
    if (!options.token.value) {
      options.errorMessage.value = "登录状态已失效，请重新登录。";
      return;
    }

    if (!fetchFn) {
      options.errorMessage.value = "当前环境不支持流式生成。";
      return;
    }

    // 上一轮已结束（done/error/canceled）则先重置状态机
    if (RESETTABLE_MACHINE_STATES.has(supervisor.state.value)) {
      supervisor.reset();
    }

    activeStreamKey.value = createResumeStreamKey();
    resetStreamState();

    try {
      await supervisor.connect(({ signal }) => {
        const params = new URLSearchParams(query);
        params.set("streamKey", activeStreamKey.value);
        params.set("sinceSeq", String(lastEventSeq.value));

        return fetchFn(
          `${API_BASE_URL}/resume/generate/stream?${params.toString()}`,
          {
            method: "GET",
            headers: {
              Accept: "text/event-stream",
              Authorization: `Bearer ${options.token.value}`,
            },
            signal,
          },
        );
      });
    } catch (error) {
      if (supervisor.state.value !== "canceled") {
        options.errorMessage.value =
          error instanceof Error ? error.message : "简历生成失败，请稍后重试。";
      }
    }
  };

  /** 校验表单并触发一次简历生成。 */
  const generateResume = async () => {
    if (!generationReady.value) {
      options.errorMessage.value =
        "生成需要填写姓名、背景、目标岗位和至少一项技能；如果暂时不填，也可以直接对话。";
      return;
    }

    lastGenerateQuery.value = buildGenerateQuery(options.form);
    await options.syncSystemContext();
    await startGenerateStream(lastGenerateQuery.value);
  };

  /** 使用最近一次的查询参数重新生成（如点击重试按钮）。 */
  const retryGenerate = async () => {
    if (!lastGenerateQuery.value) {
      options.errorMessage.value = "当前没有可重试的生成请求。";
      return;
    }

    await options.syncSystemContext();
    await startGenerateStream(lastGenerateQuery.value);
  };

  /** 取消进行中的生成。 */
  const cancelGenerate = () => {
    if (CANCELABLE_MACHINE_STATES.has(supervisor.state.value)) {
      supervisor.cancel();
    }
  };

  /** 组件卸载时取消生成并释放渲染引擎资源。 */
  const dispose = () => {
    if (CANCELABLE_MACHINE_STATES.has(supervisor.state.value)) {
      supervisor.cancel();
    }

    void resumeRenderEngine.dispose();
    void generationTypewriterSelector.reset();
  };

  // ---- 对外暴露的接口 ----
  return {
    /** 当前选中变体的标签。 */
    activeVariantLabel,
    /** 取消进行中的生成。 */
    cancelGenerate,
    /** 组件卸载时释放资源。 */
    dispose,
    /** 触发一次简历生成。 */
    generateResume,
    /** 是否正在生成。 */
    generating,
    /** 表单是否满足生成条件。 */
    generationReady,
    /** 是否已生成变体。 */
    hasGeneratedVariants,
    /** 最近一次生成请求（供重试）。 */
    lastGenerateQuery,
    /** 生成出的简历变体列表。 */
    resumeVariants,
    /** 重新生成（使用最近一次参数）。 */
    retryGenerate,
    /** 渲染引擎监控信息（调试/观测用）。 */
    resumeRenderMonitoring: resumeRenderEngine.monitoring,
    /** 当前选中的变体。 */
    selectedVariant,
    /** 当前选中变体的导出文件名。 */
    selectedVariantFileName,
    /** 当前选中的变体下标。 */
    selectedVariantIndex,
    /** 当前选中变体的 Markdown 文本。 */
    selectedVariantMarkdown,
    /** 流式预览文本。 */
    streamPreview,
    /** 生成进度（0-100）。 */
    streamProgress,
    /** 生成阶段标识。 */
    streamStage,
    /** 生成阶段的展示文案。 */
    streamStageLabel,
  };
}
