<script setup lang="ts">
import { useApiFetch } from '../composables/useApiFetch';

interface AdoptedItem {
  feedbackId: string;
  product: {
    id: string;
    name: string;
    category: string;
  };
  copy: {
    id: string;
    title: string;
    body: string;
    bullets: string[];
    cta: string;
  };
  reasonTags: string[];
  comment?: string;
  adoptedAt: string;
}

interface AdoptedListResponse {
  data: {
    items: AdoptedItem[];
  };
}

const loading = ref(true);
const errorMessage = ref('');
const items = ref<AdoptedItem[]>([]);

const loadAdopted = async () => {
  loading.value = true;
  errorMessage.value = '';

  try {
    const response = await useApiFetch<AdoptedListResponse>('/copy/adopted');
    items.value = response.data.items;
  } catch {
    errorMessage.value = '加载已采纳内容失败，请稍后重试。';
  } finally {
    loading.value = false;
  }
};

await loadAdopted();
</script>

<template>
  <section class="panel page-stack">
    <div class="section-heading">
      <div>
        <p class="eyebrow">Protected Route</p>
        <h1>内容页</h1>
      </div>
      <button class="button button-ghost" type="button" :disabled="loading" @click="loadAdopted">
        刷新
      </button>
    </div>

    <p class="muted">这里展示已采纳的商品文案与原因标签，便于沉淀可复用内容。</p>

    <p v-if="loading" class="muted">正在加载已采纳内容...</p>
    <p v-else-if="errorMessage" class="error-text">{{ errorMessage }}</p>

    <div v-else-if="items.length === 0" class="empty-state">
      <strong>暂无已采纳内容</strong>
      <span>在文案页采纳某个版本后，这里会自动展示。</span>
    </div>

    <div v-else class="list">
      <article v-for="item in items" :key="item.feedbackId" class="list-card">
        <strong>{{ item.product.name }}</strong>
        <span>{{ item.product.category }}</span>
        <p class="muted">采纳时间：{{ new Date(item.adoptedAt).toLocaleString() }}</p>

        <div class="adopted-copy">
          <p class="eyebrow">采纳文案</p>
          <strong>{{ item.copy.title }}</strong>
          <p>{{ item.copy.body }}</p>
          <ul class="bullet-list">
            <li v-for="bullet in item.copy.bullets" :key="`${item.copy.id}-${bullet}`">{{ bullet }}</li>
          </ul>
          <p class="muted">CTA：{{ item.copy.cta }}</p>
        </div>

        <div class="score-grid">
          <span v-for="tag in item.reasonTags" :key="`${item.feedbackId}-${tag}`" class="score-chip">
            {{ tag }}
          </span>
        </div>

        <p v-if="item.comment" class="muted">备注：{{ item.comment }}</p>
      </article>
    </div>
  </section>
</template>
