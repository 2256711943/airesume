<script setup lang="ts">
import { useAuth } from '../composables/useAuth';

const { user, initAuth } = useAuth();

await initAuth();
</script>

<template>
  <section class="hero">
    <div class="hero-copy">
      <p class="eyebrow">AI Content Ops Assistant</p>
      <h1>本地 MVP 已接入 JWT 鉴权和 SQLite。</h1>
      <p class="muted">
        现在已经能用真实数据库用户登录，并访问受保护接口。下一步可以继续接商品录入、文案生成和评分链路。
      </p>
    </div>

    <div class="hero-grid">
      <NuxtLink class="hero-card" to="/products">
        <strong>商品管理</strong>
        <span>验证 JWT 后访问受保护接口</span>
      </NuxtLink>
      <NuxtLink class="hero-card" to="/copy">
        <strong>文案工作台</strong>
        <span>为后续 SSE 生成链路预留入口</span>
      </NuxtLink>
      <NuxtLink class="hero-card" to="/metrics">
        <strong>指标看板</strong>
        <span>保留产品化增强的下一阶段位置</span>
      </NuxtLink>
      <NuxtLink class="hero-card" :to="user ? '/products' : '/login'">
        <strong>{{ user ? '继续工作' : '立即登录' }}</strong>
        <span>{{ user ? user.email : '进入本地数据库登录页' }}</span>
      </NuxtLink>
    </div>
  </section>
</template>
