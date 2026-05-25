<script setup lang="ts">
import { useAuth } from '../composables/useAuth';

const { user, token, logout, initAuth } = useAuth();

await initAuth();

const handleLogout = async () => {
  await logout();
  await navigateTo('/login');
};
</script>

<template>
  <div class="layout-shell">
    <header class="header">
      <NuxtLink to="/" class="brand">AI 运营内容助手</NuxtLink>
      <nav class="nav">
        <NuxtLink to="/products">商品</NuxtLink>
        <NuxtLink to="/copy">文案</NuxtLink>
        <NuxtLink to="/content">内容</NuxtLink>
        <NuxtLink to="/metrics">看板</NuxtLink>
      </nav>
      <div class="header-actions">
        <template v-if="token && user">
          <div class="user-chip">
            <strong>{{ user.name }}</strong>
            <span>{{ user.email }}</span>
          </div>
          <button class="button button-ghost" type="button" @click="handleLogout">
            退出
          </button>
        </template>
        <NuxtLink v-else to="/login" class="button button-ghost">登录</NuxtLink>
      </div>
    </header>
    <main class="main">
      <slot />
    </main>
  </div>
</template>
