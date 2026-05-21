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

interface ProductCreateResponse {
  data: Product;
}

interface ImportCsvResponse {
  data: {
    importedCount: number;
  };
}

const products = ref<Product[]>([]);
const loading = ref(true);
const errorMessage = ref('');
const submitLoading = ref(false);
const submitMessage = ref('');
const csvLoading = ref(false);
const csvMessage = ref('');

const form = reactive({
  name: '',
  category: '',
  targetAudience: '',
  platform: '',
  tone: '',
  sellingPointsText: '',
  bannedTermsText: '',
});

const csvContent = ref('');

const splitLines = (value: string): string[] => {
  return value
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
};

const loadProducts = async () => {
  loading.value = true;
  errorMessage.value = '';

  try {
    const response = await useApiFetch<ProductListResponse>('/products');
    products.value = response.data.items;
  } catch {
    errorMessage.value = '商品接口访问失败，请先确认后端服务已启动。';
  } finally {
    loading.value = false;
  }
};

const resetForm = () => {
  form.name = '';
  form.category = '';
  form.targetAudience = '';
  form.platform = '';
  form.tone = '';
  form.sellingPointsText = '';
  form.bannedTermsText = '';
};

const submitProduct = async () => {
  submitLoading.value = true;
  submitMessage.value = '';
  errorMessage.value = '';

  const sellingPoints = splitLines(form.sellingPointsText);
  const bannedTerms = splitLines(form.bannedTermsText);

  if (sellingPoints.length === 0) {
    submitMessage.value = '请至少填写一个卖点。';
    submitLoading.value = false;
    return;
  }

  try {
    await useApiFetch<ProductCreateResponse>('/products', {
      method: 'POST',
      body: {
        name: form.name,
        category: form.category,
        targetAudience: form.targetAudience,
        platform: form.platform,
        tone: form.tone,
        sellingPoints,
        bannedTerms,
      },
    });
    submitMessage.value = '商品已创建。';
    resetForm();
    await loadProducts();
  } catch {
    submitMessage.value = '创建失败，请检查后端服务和输入格式。';
  } finally {
    submitLoading.value = false;
  }
};

const importCsv = async () => {
  csvLoading.value = true;
  csvMessage.value = '';
  errorMessage.value = '';

  if (csvContent.value.trim().length === 0) {
    csvMessage.value = '请先粘贴 CSV 内容。';
    csvLoading.value = false;
    return;
  }

  try {
    const response = await useApiFetch<ImportCsvResponse>('/products/import-csv', {
      method: 'POST',
      body: {
        csvContent: csvContent.value,
      },
    });
    csvMessage.value = `已导入 ${response.data.importedCount} 条商品。`;
    await loadProducts();
  } catch {
    csvMessage.value = 'CSV 导入失败，请检查格式。';
  } finally {
    csvLoading.value = false;
  }
};

await loadProducts();
</script>

<template>
  <section class="panel page-stack">
    <div class="section-heading">
      <div>
        <p class="eyebrow">Protected Route</p>
        <h1>商品管理</h1>
      </div>
      <button class="button button-ghost" type="button" @click="loadProducts">
        刷新
      </button>
    </div>

    <p class="muted">
      页面已接通真实 JWT 和 SQLite。你可以直接录入商品并在下方看到最新列表。
    </p>

    <form class="product-form" @submit.prevent="submitProduct">
      <div class="field">
        <label for="name">商品名</label>
        <input id="name" v-model="form.name" type="text" required maxlength="100" />
      </div>

      <div class="field">
        <label for="category">分类</label>
        <input id="category" v-model="form.category" type="text" required maxlength="50" />
      </div>

      <div class="field">
        <label for="audience">目标人群</label>
        <input
          id="audience"
          v-model="form.targetAudience"
          type="text"
          required
          maxlength="100"
        />
      </div>

      <div class="field">
        <label for="platform">平台</label>
        <input id="platform" v-model="form.platform" type="text" required maxlength="30" />
      </div>

      <div class="field">
        <label for="tone">语气</label>
        <input id="tone" v-model="form.tone" type="text" required maxlength="30" />
      </div>

      <div class="field field-span">
        <label for="sellingPoints">卖点（每行一条或逗号分隔）</label>
        <textarea
          id="sellingPoints"
          v-model="form.sellingPointsText"
          rows="3"
          required
          placeholder="例如：玻尿酸补水&#10;7天改善细纹"
        />
      </div>

      <div class="field field-span">
        <label for="bannedTerms">禁用词（可选，每行一条或逗号分隔）</label>
        <textarea
          id="bannedTerms"
          v-model="form.bannedTermsText"
          rows="2"
          placeholder="例如：最便宜, 100%治愈"
        />
      </div>

      <div class="field-span form-actions">
        <button class="button button-primary" type="submit" :disabled="submitLoading">
          {{ submitLoading ? '提交中...' : '创建商品' }}
        </button>
        <span class="muted">{{ submitMessage }}</span>
      </div>
    </form>

    <section class="csv-import">
      <div class="section-heading">
        <div>
          <h2>CSV 导入</h2>
          <p class="muted">
            列顺序：<code>name,category,selling_points,target_audience,platform,tone,banned_terms</code>
            ，其中 <code>selling_points</code> / <code>banned_terms</code> 使用 <code>|</code> 分隔。
          </p>
        </div>
      </div>

      <div class="field">
        <label for="csvContent">CSV 内容</label>
        <textarea
          id="csvContent"
          v-model="csvContent"
          rows="6"
          placeholder="name,category,selling_points,target_audience,platform,tone,banned_terms&#10;抗皱精华液,beauty,玻尿酸补水|7天改善细纹,25-35女性,douyin,direct,最便宜|100%治愈"
        />
      </div>

      <div class="form-actions">
        <button class="button button-primary" type="button" :disabled="csvLoading" @click="importCsv">
          {{ csvLoading ? '导入中...' : '导入 CSV' }}
        </button>
        <span class="muted">{{ csvMessage }}</span>
      </div>
    </section>

    <p v-if="loading" class="muted">正在加载商品列表...</p>
    <p v-else-if="errorMessage" class="error-text">{{ errorMessage }}</p>

    <div v-else-if="products.length === 0" class="empty-state">
      <strong>暂无商品</strong>
      <span>你可以先用上面的表单创建第一条商品。</span>
    </div>

    <div v-else class="list">
      <article v-for="product in products" :key="product.id" class="list-card">
        <strong>{{ product.name }}</strong>
        <span>{{ product.category }} / {{ product.platform }}</span>
        <span>{{ product.targetAudience }}</span>
        <span class="muted">卖点：{{ product.sellingPoints.join(' / ') }}</span>
        <NuxtLink
          class="button button-primary"
          :to="{ path: '/copy', query: { productId: product.id } }"
        >
          去生成文案
        </NuxtLink>
      </article>
    </div>
  </section>
</template>