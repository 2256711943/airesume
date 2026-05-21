<script setup lang="ts">
import { useApiFetch } from '../composables/useApiFetch';

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

interface GenerateCopyResponse {
  data: {
    requestId: string;
    taskId: string;
    variants: CopyVariant[];
  };
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
  };
}

interface AdoptCopyResponse {
  data: {
    feedbackId: string;
  };
}

const route = useRoute();

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

const normalizeQueryValue = (value: string | string[] | undefined): string => {
  if (Array.isArray(value)) {
    return value[0] ?? '';
  }

  return value ?? '';
};

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
      selectedProductId.value = products.value[0].id;
    }
  } catch {
    errorMessage.value = '加载商品失败，请先确认后端服务已启动。';
  } finally {
    loadingProducts.value = false;
  }
};

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

const generateCopy = async () => {
  if (!selectedProduct.value) {
    generateMessage.value = '请先选择一个商品。';
    return;
  }

  generating.value = true;
  errorMessage.value = '';
  generateMessage.value = '';

  try {
    const response = await useApiFetch<GenerateCopyResponse>('/copy/generate', {
      method: 'POST',
      body: {
        productId: selectedProduct.value.id,
        platform: selectedProduct.value.platform,
        tone: selectedProduct.value.tone,
        variants: 3,
      },
    });

    requestId.value = response.data.requestId;
    taskId.value = response.data.taskId;
    variants.value = response.data.variants;
    resetResultState();

    if (variants.value.length === 0) {
      generateMessage.value = '已发起生成，但当前没有返回文案版本。';
    }
  } catch {
    errorMessage.value = '文案生成失败，请稍后重试。';
  } finally {
    generating.value = false;
  }
};

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
    rewrittenVariantIdByCopyId.value = {
      ...rewrittenVariantIdByCopyId.value,
      [copyId]: response.data.variantId,
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

const toggleAdoptReason = (copyId: string, tag: string) => {
  const currentTags = selectedReasonTagsByCopyId.value[copyId] ?? [];
  const hasTag = currentTags.includes(tag);

  selectedReasonTagsByCopyId.value = {
    ...selectedReasonTagsByCopyId.value,
    [copyId]: hasTag ? currentTags.filter((item) => item !== tag) : [...currentTags, tag],
  };
};

const updateAdoptComment = (copyId: string, value: string) => {
  adoptCommentByCopyId.value = {
    ...adoptCommentByCopyId.value,
    [copyId]: value,
  };
};

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
      先选择商品，再调用 <code>/copy/generate</code> 生成 3 个文案版本，形成“商品到文案”的主链路。
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
          {{ generating ? '生成中...' : '生成 3 个版本' }}
        </button>
        <span class="muted">{{ generateMessage }}</span>
      </div>
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
              :disabled="Boolean(scoringByCopyId[variant.id])"
              @click="scoreVariant(variant.id)"
            >
              {{ scoringByCopyId[variant.id] ? '评分中...' : '评分' }}
            </button>
            <button
              class="button button-ghost"
              type="button"
              :disabled="Boolean(rewritingByCopyId[variant.id])"
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
                :disabled="Boolean(adoptingByCopyId[variant.id])"
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