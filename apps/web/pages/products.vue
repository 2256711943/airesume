<script setup lang="ts">
import { useApiFetch } from '../composables/useApiFetch';

interface Product {
  id: string;
  name: string;
  category: string;
  platform: string;
  tone: string;
  targetAudience: string;
}

interface ProductListResponse {
  data: {
    items: Product[];
  };
}

const products = ref<Product[]>([]);
const loading = ref(true);
const errorMessage = ref('');

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
      这个页面已经走真实 JWT 鉴权。当前接口返回的商品列表仍为空，但登录和受保护请求链路已联通。
    </p>

    <p v-if="loading" class="muted">正在加载商品列表...</p>
    <p v-else-if="errorMessage" class="error-text">{{ errorMessage }}</p>

    <div v-else-if="products.length === 0" class="empty-state">
      <strong>暂无商品</strong>
      <span>下一步可以把手动录入和 CSV 导入页面接到后端。</span>
    </div>

    <div v-else class="list">
      <article v-for="product in products" :key="product.id" class="list-card">
        <strong>{{ product.name }}</strong>
        <span>{{ product.category }} / {{ product.platform }}</span>
        <span>{{ product.targetAudience }}</span>
      </article>
    </div>
  </section>
</template>
