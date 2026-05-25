<script setup lang="ts">
import { useApiFetch } from '../composables/useApiFetch';
import { useAuth } from '../composables/useAuth';

interface Product {
  id: string;
  name: string;
  category: string;
  platform: string;
  tone: string;
  targetAudience: string;
  sellingPoints: string[];
  bannedTerms: string[];
}

interface ProductListResponse {
  data: {
    items: Product[];
  };
}

interface CopyVariant {
  id: string;
  title: string;
  body: string;
  bullets: string[];
  cta: string;
}

interface StreamStartPayload {
  requestId?: string;
  taskId?: string;
}

interface StreamProgressPayload extends StreamStartPayload {
  progress?: number;
  stage?: string;
}

interface StreamChunkPayload extends StreamStartPayload {
  text?: string;
}

interface StreamDonePayload extends StreamStartPayload {
  variants?: unknown;
}

interface StreamErrorPayload extends StreamStartPayload {
  code?: string;
  message?: string;
}

interface ScoreResult {
  ruleScore: number;
  llmScore: number;
  overallScore: number;
  dimensions: Record<string, number>;
}

interface ScoreCopyResponse {
  data: ScoreResult;
}

interface RewriteCopyResponse {
  data: {
    variantId: string;
    variant: CopyVariant;
  };
}

interface AdoptCopyResponse {
  data: {
    feedbackId: string;
  };
}

interface GenerateRequest {
  productId: string;
  platform: string;
  tone: string;
  variants: number;
}

type StreamEventName = 'start' | 'progress' | 'chunk' | 'done' | 'error' | 'canceled';

const API_BASE_URL = 'http://127.0.0.1:3001';
const route = useRoute();
const { token, clearAuth } = useAuth();

const adoptReasonOptions = [
  { value: 'hook_strong', label: '开头抓人' },
  { value: 'platform_fit_good', label: '平台适配' },
  { value: 'selling_points_clear', label: '卖点清晰' },
  { value: 'cta_effective', label: '行动引导强' },
] as const;

const products = ref<Product[]>([]);
const selectedProductId = ref('');
const generating = ref(false);
const loadingProducts = ref(true);
const errorMessage = ref('');
const generateMessage = ref('');
const requestId = ref('');
const taskId = ref('');
const variants = ref<CopyVariant[]>([]);
const streamProgress = ref(0);
const streamStage = ref('');
const streamPreview = ref('');
const retryable = ref(false);
const lastGenerateRequest = ref<GenerateRequest | null>(null);
const currentStreamController = ref<AbortController | null>(null);
const scoreByCopyId = ref<Record<string, ScoreResult>>({});
const scoreErrorByCopyId = ref<Record<string, string>>({});
const scoringByCopyId = ref<Record<string, boolean>>({});
const rewrittenVariantIdByCopyId = ref<Record<string, string>>({});
const rewriteErrorByCopyId = ref<Record<string, string>>({});
const rewritingByCopyId = ref<Record<string, boolean>>({});
const selectedReasonTagsByCopyId = ref<Record<string, string[]>>({});
const adoptCommentByCopyId = ref<Record<string, string>>({});
const adoptingByCopyId = ref<Record<string, boolean>>({});
const adoptErrorByCopyId = ref<Record<string, string>>({});
const adoptFeedbackIdByCopyId = ref<Record<string, string>>({});

const selectedProduct = computed(() => {
  return products.value.find((product) => product.id === selectedProductId.value) ?? null;
});

const streamStageLabel = computed(() => {
  if (!streamStage.value) {
    return generating.value ? '准备中' : '空闲';
  }

  if (streamStage.value === 'planning') {
    return '规划中';
  }

  if (streamStage.value === 'generating') {
    return '生成中';
  }

  if (streamStage.value === 'post_processing') {
    return '收尾中';
  }

  return streamStage.value;
});

/** 统一把路由 query 值归一化为单个字符串。 */
const normalizeQueryValue = (
  value: string | null | Array<string | null> | undefined,
): string => {
  if (Array.isArray(value)) {
    return value.find((item) => typeof item === 'string' && item.length > 0) ?? '';
  }

  return value ?? '';
};

/** 将未知值安全转换为数字。 */
const toNumber = (value: unknown, fallback = 0): number => {
  const num = Number(value);
  if (Number.isNaN(num)) {
    return fallback;
  }

  return num;
};

/** 判断未知值是否满足文案版本结构。 */
const isCopyVariant = (value: unknown): value is CopyVariant => {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const item = value as Record<string, unknown>;
  return (
    typeof item.id === 'string' &&
    typeof item.title === 'string' &&
    typeof item.body === 'string' &&
    Array.isArray(item.bullets) &&
    typeof item.cta === 'string'
  );
};

/** 将 SSE done 里的 variants 数据解析为前端模型。 */
const parseVariants = (value: unknown): CopyVariant[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(isCopyVariant)
    .map((item) => ({
      id: item.id,
      title: item.title,
      body: item.body,
      bullets: item.bullets.map((bullet) => String(bullet)),
      cta: item.cta,
    }));
};

/** 更新当前流式请求的 requestId 和 taskId。 */
const updateStreamContext = (payload: StreamStartPayload) => {
  if (typeof payload.requestId === 'string' && payload.requestId.length > 0) {
    requestId.value = payload.requestId;
  }

  if (typeof payload.taskId === 'string' && payload.taskId.length > 0) {
    taskId.value = payload.taskId;
  }
};

/** 拉取当前用户可用的商品列表。 */
const loadProducts = async () => {
  loadingProducts.value = true;
  errorMessage.value = '';

  try {
    const response = await useApiFetch<ProductListResponse>('/products');
    products.value = response.data.items;

    const queryProductId = normalizeQueryValue(route.query.productId);
    const hasQueryProduct = products.value.some((product) => product.id === queryProductId);

    if (hasQueryProduct) {
      selectedProductId.value = queryProductId;
    } else if (products.value.length > 0) {
      const firstProduct = products.value.at(0);
      if (firstProduct) {
        selectedProductId.value = firstProduct.id;
      }
    }
  } catch {
    errorMessage.value = '加载商品失败，请先确认后端服务已启动。';
  } finally {
    loadingProducts.value = false;
  }
};

/** 重置评分、改写与采纳结果状态。 */
const resetResultState = () => {
  scoreByCopyId.value = {};
  scoreErrorByCopyId.value = {};
  scoringByCopyId.value = {};
  rewrittenVariantIdByCopyId.value = {};
  rewriteErrorByCopyId.value = {};
  rewritingByCopyId.value = {};
  selectedReasonTagsByCopyId.value = {};
  adoptCommentByCopyId.value = {};
  adoptingByCopyId.value = {};
  adoptErrorByCopyId.value = {};
  adoptFeedbackIdByCopyId.value = {};
};

/** 重置流式生成展示状态。 */
const resetStreamState = () => {
  streamProgress.value = 0;
  streamStage.value = '';
  streamPreview.value = '';
};

/** 拼接 SSE 流式接口地址。 */
const buildStreamUrl = (request: GenerateRequest): string => {
  const params = new URLSearchParams({
    productId: request.productId,
    platform: request.platform,
    tone: request.tone,
    variants: String(request.variants),
  });

  return `${API_BASE_URL}/copy/generate/stream?${params.toString()}`;
};

/** 根据 SSE 事件名更新前端流式状态。 */
const handleStreamEvent = (eventName: string, payload: Record<string, unknown>) => {
  const event = eventName as StreamEventName;

  if (
    event !== 'start' &&
    event !== 'progress' &&
    event !== 'chunk' &&
    event !== 'done' &&
    event !== 'error' &&
    event !== 'canceled'
  ) {
    return;
  }

  if (event === 'start') {
    updateStreamContext(payload as StreamStartPayload);
    streamProgress.value = 0;
    streamStage.value = 'planning';
    return;
  }

  if (event === 'progress') {
    const progressPayload = payload as StreamProgressPayload;
    updateStreamContext(progressPayload);
    streamProgress.value = Math.max(0, Math.min(100, toNumber(progressPayload.progress, 0)));
    if (typeof progressPayload.stage === 'string') {
      streamStage.value = progressPayload.stage;
    }
    return;
  }

  if (event === 'chunk') {
    const chunkPayload = payload as StreamChunkPayload;
    updateStreamContext(chunkPayload);
    if (typeof chunkPayload.text === 'string') {
      streamPreview.value += chunkPayload.text;
    }
    return;
  }

  if (event === 'done') {
    const donePayload = payload as StreamDonePayload;
    updateStreamContext(donePayload);
    streamProgress.value = 100;
    streamStage.value = 'post_processing';
    variants.value = parseVariants(donePayload.variants);
    generateMessage.value = '流式生成完成。';
    retryable.value = false;
    return;
  }

  if (event === 'error') {
    const errorPayload = payload as StreamErrorPayload;
    updateStreamContext(errorPayload);
    const code = typeof errorPayload.code === 'string' ? `[${errorPayload.code}] ` : '';
    const message =
      typeof errorPayload.message === 'string'
        ? errorPayload.message
        : '流式生成失败，请稍后重试。';
    errorMessage.value = `${code}${message}`;
    retryable.value = true;
    return;
  }

  updateStreamContext(payload as StreamStartPayload);
  generateMessage.value = '已取消生成。';
  retryable.value = true;
};

/** 读取并解析 SSE 数据流。 */
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

    const rawData = dataParts.join('\n');
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(rawData) as Record<string, unknown>;
    } catch {
      return;
    }

    handleStreamEvent(eventName, payload);
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

/** 发起一次流式生成请求并驱动前端状态机。 */
const startGenerateStream = async (request: GenerateRequest) => {
  if (!token.value) {
    errorMessage.value = '登录状态已失效，请重新登录。';
    return;
  }

  generating.value = true;
  errorMessage.value = '';
  generateMessage.value = '';
  retryable.value = false;
  requestId.value = '';
  taskId.value = '';
  variants.value = [];
  resetResultState();
  resetStreamState();

  const controller = new AbortController();
  currentStreamController.value = controller;

  try {
    const response = await fetch(buildStreamUrl(request), {
      method: 'GET',
      headers: {
        Accept: 'text/event-stream',
        Authorization: `Bearer ${token.value}`,
      },
      signal: controller.signal,
    });

    if (response.status === 401) {
      clearAuth();
      throw new Error('登录状态已过期，请重新登录。');
    }

    if (!response.ok) {
      throw new Error(`流式接口返回异常：HTTP ${response.status}`);
    }

    if (!response.body) {
      throw new Error('流式接口未返回可读数据流。');
    }

    await consumeSseStream(response.body);
    if (variants.value.length === 0 && !errorMessage.value) {
      generateMessage.value = '已完成生成，但当前没有返回文案版本。';
      retryable.value = true;
    }
  } catch (error) {
    if (controller.signal.aborted) {
      generateMessage.value = '已取消生成。';
      retryable.value = true;
    } else {
      const message = error instanceof Error ? error.message : '流式生成失败，请稍后重试。';
      errorMessage.value = message;
      retryable.value = true;
    }
  } finally {
    generating.value = false;
    currentStreamController.value = null;
  }
};

/** 从当前选中商品发起一次新的生成请求。 */
const generateCopy = async () => {
  if (!selectedProduct.value) {
    generateMessage.value = '请先选择一个商品。';
    return;
  }

  const request: GenerateRequest = {
    productId: selectedProduct.value.id,
    platform: selectedProduct.value.platform,
    tone: selectedProduct.value.tone,
    variants: 3,
  };

  lastGenerateRequest.value = request;
  await startGenerateStream(request);
};

/** 重试最近一次生成请求。 */
const retryGenerate = async () => {
  if (!lastGenerateRequest.value) {
    generateMessage.value = '没有可重试的请求，请先发起一次生成。';
    return;
  }

  await startGenerateStream(lastGenerateRequest.value);
};

/** 取消当前进行中的流式生成。 */
const cancelGenerate = () => {
  if (!currentStreamController.value) {
    return;
  }

  currentStreamController.value.abort();
};

/** 对单个文案版本发起评分请求。 */
const scoreVariant = async (copyId: string) => {
  if (!copyId) {
    return;
  }

  scoringByCopyId.value = {
    ...scoringByCopyId.value,
    [copyId]: true,
  };
  scoreErrorByCopyId.value = {
    ...scoreErrorByCopyId.value,
    [copyId]: '',
  };

  try {
    const response = await useApiFetch<ScoreCopyResponse>(`/copy/${copyId}/score`, {
      method: 'POST',
    });
    scoreByCopyId.value = {
      ...scoreByCopyId.value,
      [copyId]: response.data,
    };
  } catch {
    scoreErrorByCopyId.value = {
      ...scoreErrorByCopyId.value,
      [copyId]: '评分失败，请重试。',
    };
  } finally {
    scoringByCopyId.value = {
      ...scoringByCopyId.value,
      [copyId]: false,
    };
  }
};

/** 基于当前版本触发改写请求。 */
const rewriteVariant = async (copyId: string) => {
  if (!copyId) {
    return;
  }

  rewritingByCopyId.value = {
    ...rewritingByCopyId.value,
    [copyId]: true,
  };
  rewriteErrorByCopyId.value = {
    ...rewriteErrorByCopyId.value,
    [copyId]: '',
  };

  try {
    const response = await useApiFetch<RewriteCopyResponse>(`/copy/${copyId}/rewrite`, {
      method: 'POST',
    });
    const rewrittenVariant = response.data.variant;
    const targetIndex = variants.value.findIndex((item) => item.id === copyId);
    if (targetIndex >= 0) {
      variants.value.splice(targetIndex, 1, rewrittenVariant);
    }
    rewrittenVariantIdByCopyId.value = {
      ...rewrittenVariantIdByCopyId.value,
      [rewrittenVariant.id]: response.data.variantId,
    };
  } catch {
    rewriteErrorByCopyId.value = {
      ...rewriteErrorByCopyId.value,
      [copyId]: '改写失败，请重试。',
    };
  } finally {
    rewritingByCopyId.value = {
      ...rewritingByCopyId.value,
      [copyId]: false,
    };
  }
};

/** 切换某个版本的采纳原因标签。 */
const toggleAdoptReason = (copyId: string, tag: string) => {
  const currentTags = selectedReasonTagsByCopyId.value[copyId] ?? [];
  const hasTag = currentTags.includes(tag);

  selectedReasonTagsByCopyId.value = {
    ...selectedReasonTagsByCopyId.value,
    [copyId]: hasTag ? currentTags.filter((item) => item !== tag) : [...currentTags, tag],
  };
};

/** 更新某个版本的采纳备注。 */
const updateAdoptComment = (copyId: string, value: string) => {
  adoptCommentByCopyId.value = {
    ...adoptCommentByCopyId.value,
    [copyId]: value,
  };
};

/** 提交某个版本的采纳反馈。 */
const adoptVariant = async (copyId: string) => {
  if (!copyId) {
    return;
  }

  const reasonTags = selectedReasonTagsByCopyId.value[copyId] ?? [];
  if (reasonTags.length === 0) {
    adoptErrorByCopyId.value = {
      ...adoptErrorByCopyId.value,
      [copyId]: '请至少选择一个采纳原因标签。',
    };
    return;
  }

  adoptingByCopyId.value = {
    ...adoptingByCopyId.value,
    [copyId]: true,
  };
  adoptErrorByCopyId.value = {
    ...adoptErrorByCopyId.value,
    [copyId]: '',
  };

  try {
    const response = await useApiFetch<AdoptCopyResponse>(`/copy/${copyId}/adopt`, {
      method: 'POST',
      body: {
        adopted: true,
        reasonTags,
        comment: adoptCommentByCopyId.value[copyId] ?? '',
      },
    });

    adoptFeedbackIdByCopyId.value = {
      ...adoptFeedbackIdByCopyId.value,
      [copyId]: response.data.feedbackId,
    };
  } catch {
    adoptErrorByCopyId.value = {
      ...adoptErrorByCopyId.value,
      [copyId]: '采纳失败，请重试。',
    };
  } finally {
    adoptingByCopyId.value = {
      ...adoptingByCopyId.value,
      [copyId]: false,
    };
  }
};

onBeforeUnmount(() => {
  if (currentStreamController.value) {
    currentStreamController.value.abort();
  }
});

await loadProducts();
</script>

<template>
  <section class="panel page-stack">
    <div class="section-heading">
      <div>
        <p class="eyebrow">Protected Route</p>
        <h1>文案工作台</h1>
      </div>
      <button class="button button-ghost" type="button" :disabled="loadingProducts" @click="loadProducts">
        刷新商品
      </button>
    </div>

    <p class="muted">
      先选择商品，再调用 <code>/copy/generate/stream</code> 流式生成 3 个文案版本，支持取消与重试。
    </p>

    <div class="copy-generator">
      <div class="field field-span">
        <label for="productSelect">选择商品</label>
        <select id="productSelect" v-model="selectedProductId" :disabled="loadingProducts || products.length === 0">
          <option value="" disabled>请选择商品</option>
          <option v-for="product in products" :key="product.id" :value="product.id">
            {{ product.name }}（{{ product.platform }} / {{ product.tone }}）
          </option>
        </select>
      </div>

      <div v-if="selectedProduct" class="selected-product">
        <strong>{{ selectedProduct.name }}</strong>
        <span>{{ selectedProduct.category }} / {{ selectedProduct.targetAudience }}</span>
        <span class="muted">卖点：{{ selectedProduct.sellingPoints.join(' / ') }}</span>
      </div>

      <div class="form-actions">
        <button
          class="button button-primary"
          type="button"
          :disabled="generating || loadingProducts || !selectedProduct"
          @click="generateCopy"
        >
          {{ generating ? '生成中...' : '开始流式生成' }}
        </button>
        <button class="button button-ghost" type="button" :disabled="!generating" @click="cancelGenerate">
          取消生成
        </button>
        <button class="button button-ghost" type="button" :disabled="generating || !retryable" @click="retryGenerate">
          重试
        </button>
        <span class="muted">{{ generateMessage }}</span>
      </div>
    </div>

    <div v-if="generating || streamPreview || streamProgress > 0" class="list-card">
      <p class="eyebrow">流式状态</p>
      <p class="muted">requestId: {{ requestId || '-' }} / taskId: {{ taskId || '-' }}</p>
      <p class="muted">阶段：{{ streamStageLabel }} / 进度：{{ streamProgress }}%</p>
      <p>{{ streamPreview || '等待首段内容返回...' }}</p>
    </div>

    <p v-if="errorMessage" class="error-text">{{ errorMessage }}</p>

    <section v-if="variants.length > 0" class="copy-result">
      <div class="section-heading">
        <div>
          <h2>生成结果</h2>
          <p class="muted">requestId: {{ requestId }} / taskId: {{ taskId }}</p>
        </div>
      </div>

      <div class="list">
        <article v-for="(variant, index) in variants" :key="variant.id" class="list-card">
          <p class="eyebrow">版本 {{ index + 1 }}</p>
          <strong>{{ variant.title }}</strong>
          <p>{{ variant.body }}</p>
          <ul class="bullet-list">
            <li v-for="bullet in variant.bullets" :key="`${variant.id}-${bullet}`">{{ bullet }}</li>
          </ul>
          <p class="muted">CTA：{{ variant.cta }}</p>

          <div class="form-actions">
            <button
              class="button button-ghost"
              type="button"
              :disabled="Boolean(scoringByCopyId[variant.id]) || generating"
              @click="scoreVariant(variant.id)"
            >
              {{ scoringByCopyId[variant.id] ? '评分中...' : '评分' }}
            </button>
            <button
              class="button button-ghost"
              type="button"
              :disabled="Boolean(rewritingByCopyId[variant.id]) || generating"
              @click="rewriteVariant(variant.id)"
            >
              {{ rewritingByCopyId[variant.id] ? '改写中...' : '改写' }}
            </button>
          </div>

          <span v-if="scoreErrorByCopyId[variant.id]" class="error-text">
            {{ scoreErrorByCopyId[variant.id] }}
          </span>
          <span v-if="rewriteErrorByCopyId[variant.id]" class="error-text">
            {{ rewriteErrorByCopyId[variant.id] }}
          </span>

          <div v-if="scoreByCopyId[variant.id]" class="score-grid">
            <span class="score-chip">规则分：{{ scoreByCopyId[variant.id].ruleScore }}</span>
            <span class="score-chip">LLM 分：{{ scoreByCopyId[variant.id].llmScore }}</span>
          </div>

          <p v-if="rewrittenVariantIdByCopyId[variant.id]" class="muted">
            已生成改写版本：{{ rewrittenVariantIdByCopyId[variant.id] }}
          </p>

          <div class="adopt-box">
            <strong>采纳反馈</strong>

            <div class="adopt-tags">
              <button
                v-for="reason in adoptReasonOptions"
                :key="reason.value"
                type="button"
                class="tag-button"
                :class="{ 'tag-button-active': (selectedReasonTagsByCopyId[variant.id] ?? []).includes(reason.value) }"
                @click="toggleAdoptReason(variant.id, reason.value)"
              >
                {{ reason.label }}
              </button>
            </div>

            <div class="field">
              <label :for="`adopt-comment-${variant.id}`">备注（可选）</label>
              <textarea
                :id="`adopt-comment-${variant.id}`"
                rows="2"
                :value="adoptCommentByCopyId[variant.id] ?? ''"
                @input="updateAdoptComment(variant.id, ($event.target as HTMLTextAreaElement).value)"
              />
            </div>

            <div class="form-actions">
              <button
                class="button button-primary"
                type="button"
                :disabled="Boolean(adoptingByCopyId[variant.id]) || generating"
                @click="adoptVariant(variant.id)"
              >
                {{ adoptingByCopyId[variant.id] ? '采纳提交中...' : '采纳此版本' }}
              </button>
              <span v-if="adoptFeedbackIdByCopyId[variant.id]" class="muted">
                已采纳，反馈ID：{{ adoptFeedbackIdByCopyId[variant.id] }}
              </span>
            </div>

            <span v-if="adoptErrorByCopyId[variant.id]" class="error-text">
              {{ adoptErrorByCopyId[variant.id] }}
            </span>
          </div>
        </article>
      </div>
    </section>
  </section>
</template>
