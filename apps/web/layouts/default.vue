<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from '#imports';
import { useAuth } from '../composables/useAuth';

const route = useRoute();
const { user, token, logout, initAuth } = useAuth();

await initAuth();

const navItems = [
  { label: 'Agent', icon: '✦', to: '/resume' },
  { label: '简历', icon: '▣', to: '/resume' },
  { label: '校招', icon: '◫', to: '/' },
  { label: 'OpenClaw', icon: '</>', to: '/' },
  { label: '用户反馈', icon: '◌', to: '/' },
  { label: '产品更新', icon: '⚑', to: '/' },
  { label: '加入我们', icon: '▤', to: '/' },
];

const pageTitleMap: Record<string, string> = {
  '/': 'Dashboard',
  '/resume': 'Agent',
  '/login': 'Login',
};

const activePath = computed(() => {
  if (route.path === '/resume') {
    return '/resume';
  }

  return '/';
});

const currentTitle = computed(() => pageTitleMap[route.path] ?? 'Workspace');

const handleLogout = async () => {
  await logout();
  await navigateTo('/login');
};
</script>

<template>
  <div class="workspace-layout">
    <aside class="sidebar-panel">
      <div class="brand-row">
        <NuxtLink to="/" class="brand-mark">UP</NuxtLink>
      </div>

      <nav class="sidebar-nav">
        <NuxtLink
          v-for="item in navItems"
          :key="item.label"
          :to="item.to"
          class="sidebar-item"
          :class="{ active: activePath === item.to && item.label === 'Agent' ? route.path === '/resume' : activePath === item.to && route.path === '/' }"
        >
          <span class="sidebar-icon">{{ item.icon }}</span>
          <span>{{ item.label }}</span>
        </NuxtLink>
      </nav>

      <section class="history-box">
        <div class="history-header">
          <span>历史对话</span>
          <button type="button">+</button>
        </div>
        <p>暂无对话记录</p>
      </section>

      <footer class="sidebar-user">
        <div class="user-avatar">{{ user?.name?.slice(0, 1) ?? '微' }}</div>
        <div class="user-meta">
          <strong>{{ user?.name ?? '微信用户' }}</strong>
          <p>{{ user?.email ?? '暂未登录' }}</p>
        </div>
        <button v-if="token" type="button" class="user-action" @click="handleLogout">⏻</button>
      </footer>
    </aside>

    <div class="workspace-main">
      <header class="workspace-topbar">
        <div class="topbar-actions">
          <button type="button" class="icon-button">‹</button>
          <button type="button" class="icon-button">⊟</button>
          <button type="button" class="icon-button">✎</button>
        </div>

        <div class="page-title">
          <h1>{{ currentTitle }}</h1>
        </div>

        <div class="topbar-right">
          <NuxtLink v-if="!token" to="/login" class="topbar-link">登录</NuxtLink>
          <div v-else class="topbar-user">
            <strong>{{ user?.name }}</strong>
            <span>{{ user?.email }}</span>
          </div>
        </div>
      </header>

      <main class="workspace-content">
        <slot />
      </main>
    </div>
  </div>
</template>

<style scoped>
.workspace-layout {
  min-height: 100vh;
  display: grid;
  grid-template-columns: 316px minmax(0, 1fr);
  background: linear-gradient(180deg, #f8f9fc 0%, #f3f5fb 100%);
}

.sidebar-panel {
  display: grid;
  grid-template-rows: auto auto 1fr auto;
  gap: 24px;
  padding: 18px 14px;
  background: rgba(255, 255, 255, 0.94);
  border-right: 1px solid #edf0f6;
}

.brand-row {
  display: flex;
  align-items: center;
  min-height: 40px;
}

.brand-mark {
  color: #2f5cff;
  font-size: 22px;
  font-weight: 800;
  letter-spacing: -0.08em;
  text-decoration: none;
}

.sidebar-nav {
  display: grid;
  gap: 6px;
}

.sidebar-item {
  display: flex;
  align-items: center;
  gap: 14px;
  min-height: 48px;
  padding: 0 14px;
  border-radius: 14px;
  color: #5d6678;
  font-size: 15px;
  text-decoration: none;
  transition: all 0.2s ease;
}

.sidebar-item.active {
  background: #edf1ff;
  color: #355bff;
  font-weight: 700;
}

.sidebar-icon {
  width: 24px;
  text-align: center;
}

.history-box {
  align-self: end;
  display: grid;
  gap: 14px;
  padding-top: 18px;
  border-top: 1px solid #eef1f7;
}

.history-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: #5c6678;
  font-size: 14px;
  font-weight: 700;
}

.history-header button {
  border: 0;
  background: transparent;
  color: #6b7386;
  font-size: 28px;
  cursor: pointer;
}

.history-box p,
.sidebar-user p,
.topbar-user span {
  margin: 0;
  color: #98a1b2;
  font-size: 13px;
  line-height: 1.7;
}

.sidebar-user {
  display: flex;
  align-items: center;
  gap: 12px;
}

.user-avatar {
  width: 46px;
  height: 46px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: linear-gradient(180deg, #2f5cff, #4f6fff);
  color: #ffffff;
  font-weight: 700;
}

.user-meta {
  display: grid;
}

.user-action {
  margin-left: auto;
  border: 0;
  background: transparent;
  color: #6b7386;
  cursor: pointer;
}

.workspace-main {
  display: grid;
  grid-template-rows: auto 1fr;
}

.workspace-topbar {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  min-height: 70px;
  padding: 18px 28px 8px;
}

.topbar-actions {
  display: flex;
  gap: 10px;
}

.icon-button {
  width: 34px;
  height: 34px;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: #7c8497;
  font-size: 18px;
  cursor: pointer;
}

.page-title {
  text-align: center;
}

.page-title h1 {
  margin: 0;
  color: #2f3747;
  font-size: 28px;
  font-weight: 700;
}

.topbar-right {
  display: flex;
  justify-content: flex-end;
}

.topbar-link {
  color: #355bff;
  text-decoration: none;
  font-weight: 700;
}

.topbar-user {
  display: grid;
  text-align: right;
}

.workspace-content {
  padding: 10px 28px 28px;
}

@media (max-width: 1100px) {
  .workspace-layout {
    grid-template-columns: 1fr;
  }

  .sidebar-panel {
    display: none;
  }

  .workspace-topbar,
  .workspace-content {
    padding-left: 16px;
    padding-right: 16px;
  }
}

@media (max-width: 900px) {
  .workspace-topbar {
    grid-template-columns: 1fr;
    gap: 12px;
  }

  .topbar-actions,
  .topbar-right {
    display: none;
  }

  .page-title {
    text-align: left;
  }
}
</style>
