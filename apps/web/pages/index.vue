<script setup lang="ts">
import { useAuth } from '../composables/useAuth';

const { user, initAuth } = useAuth();

await initAuth();
</script>

<template>
  <section class="dashboard-page">
    <article class="hero-card">
      <p class="eyebrow">AI Resume Assistant</p>
      <h2>简历生成最小闭环已就绪</h2>
      <p>
        已接入 JWT 鉴权与流式接口能力。当前可以直接体验“输入个人信息 -> SSE 实时生成结构化简历”的完整链路。
      </p>
    </article>

    <section class="card-grid">
      <NuxtLink class="feature-card" to="/resume">
        <strong>简历生成</strong>
        <span>主入口：流式生成结构化简历内容</span>
      </NuxtLink>

      <NuxtLink class="feature-card" :to="user ? '/resume' : '/login'">
        <strong>{{ user ? '继续生成简历' : '立即登录' }}</strong>
        <span>{{ user ? user.email : '登录后进入 AI 简历工作台' }}</span>
      </NuxtLink>
    </section>
  </section>
</template>

<style scoped>
.dashboard-page {
  display: grid;
  gap: 20px;
  max-width: 960px;
}

.hero-card,
.feature-card {
  background: #ffffff;
  border-radius: 24px;
  box-shadow: 0 12px 34px rgba(21, 30, 55, 0.08);
}

.hero-card {
  padding: 28px;
}

.eyebrow {
  margin: 0 0 8px;
  color: #9aa2b3;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.18em;
  text-transform: uppercase;
}

.hero-card h2 {
  margin: 0;
  color: #2f3747;
  font-size: 32px;
}

.hero-card p:last-child {
  margin: 14px 0 0;
  color: #7f889b;
  line-height: 1.8;
}

.card-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 18px;
}

.feature-card {
  display: grid;
  gap: 10px;
  padding: 24px;
  color: #2f3747;
  text-decoration: none;
  transition: transform 0.2s ease, box-shadow 0.2s ease;
}

.feature-card span {
  color: #8d95a5;
  line-height: 1.7;
}

.feature-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 18px 32px rgba(58, 88, 245, 0.1);
}

@media (max-width: 900px) {
  .card-grid {
    grid-template-columns: 1fr;
  }
}
</style>
