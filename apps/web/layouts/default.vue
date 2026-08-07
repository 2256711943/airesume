<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "#imports";
import { useAuth } from "../composables/useAuth";
import { createResumeFormState } from "../utils/resume";
import { writeResumeSessionSnapshot } from "../utils/resume-session";

const route = useRoute();
const { user, token, logout, initAuth } = useAuth();

await initAuth();

const navItems = [
  { label: "简历工作台", icon: "AI", to: "/resume" },
  {
    label: "个人简历库",
    icon: "LIB",
    to: "/resume",
    query: { tab: "library" },
  },
  { label: "首页", icon: "HM", to: "/" },
];

const pageTitleMap: Record<string, string> = {
  "/": "AI 对话",
  "/resume": "简历对话工作台",
  "/login": "登录",
};

const isLibraryRoute = computed(
  () => route.path === "/resume" && route.query.tab === "library",
);

const currentTitle = computed(() => {
  if (isLibraryRoute.value) {
    return "个人简历库";
  }

  return pageTitleMap[route.path] ?? "Workspace";
});

const isNavItemActive = (item: {
  to: string;
  query?: Record<string, string>;
}) => {
  if (route.path !== item.to) {
    return false;
  }

  if (!item.query) {
    return true;
  }

  return Object.entries(item.query).every(
    ([key, value]) => route.query[key] === value,
  );
};

const handleLogout = async () => {
  await logout();
  await navigateTo("/login");
};

/**
 * 侧边栏“创建简历”CTA：写入一条空的表单会话草稿，
 * 让工作台进入后立即弹出表单气泡供填写（与首页“创建简历”一致）。
 */
const startResumeCreation = () => {
  const storage =
    typeof localStorage === "undefined" ? undefined : localStorage;
  writeResumeSessionSnapshot(
    storage,
    `aitext_resume_session:${user.value?.id ?? "anonymous"}`,
    {
      conversationId: "",
      form: createResumeFormState(),
      resumeVariants: [],
      selectedVariantIndex: 0,
      lastGenerateQuery: "",
      formDismissed: false,
    },
  );
  navigateTo("/resume");
};
</script>

<template>
  <div class="workspace-layout">
    <aside class="sidebar-panel">
      <div class="brand-row">
        <NuxtLink to="/" class="brand-mark"> UP </NuxtLink>
      </div>

      <nav class="sidebar-nav">
        <NuxtLink
          v-for="item in navItems"
          :key="item.label"
          :to="item.query ? { path: item.to, query: item.query } : item.to"
          class="sidebar-item"
          :class="{ active: isNavItemActive(item) }"
        >
          <span class="sidebar-icon">{{ item.icon }}</span>
          <span>{{ item.label }}</span>
        </NuxtLink>
      </nav>

      <button
        type="button"
        class="sidebar-create-button"
        @click="startResumeCreation"
      >
        <span class="sidebar-create-icon">＋</span>
        创建简历
      </button>

      <section class="history-box">
        <div class="history-header">
          <span>历史对话</span>
          <button type="button">+</button>
        </div>
        <p>当前没有对话记录。</p>
      </section>

      <footer class="sidebar-user">
        <div class="user-avatar">
          {{ user?.name?.slice(0, 1) ?? "未" }}
        </div>
        <div class="user-meta">
          <strong>{{ user?.name ?? "未登录用户" }}</strong>
          <p>{{ user?.email ?? "暂无账号信息" }}</p>
        </div>
        <button
          v-if="token"
          type="button"
          class="user-action"
          @click="handleLogout"
        >
          退出
        </button>
      </footer>
    </aside>

    <div class="workspace-main">
      <header class="workspace-topbar">
        <div class="topbar-actions">
          <button type="button" class="icon-button">--</button>
          <button type="button" class="icon-button">+-</button>
          <button type="button" class="icon-button">AI</button>
        </div>

        <div class="page-title">
          <h1>{{ currentTitle }}</h1>
        </div>

        <div class="topbar-right">
          <NuxtLink v-if="!token" to="/login" class="topbar-link">
            登录
          </NuxtLink>
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
  grid-template-columns: clamp(220px, 20vw, 280px) minmax(0, 1fr);
  gap: 18px;
  padding: 18px;
  background: transparent;
}

.sidebar-panel {
  display: grid;
  /* 显式单列且允许收缩：避免隐式 auto 列被网格项的 min-content 撑爆导致卡片越界 */
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: auto auto auto 1fr auto;
  gap: 18px;
  padding: 18px 16px;
  border: 1px solid var(--app-border);
  border-radius: 30px;
  background: rgba(255, 255, 255, 0.74);
  box-shadow: var(--app-shadow-md);
  backdrop-filter: blur(22px) saturate(160%);
  -webkit-backdrop-filter: blur(22px) saturate(160%);
  /* 入场：先于主区出现 */
  animation: fade-in-up 0.5s cubic-bezier(0.16, 1, 0.3, 1) both;
}

.brand-row {
  display: flex;
  align-items: center;
  min-height: 40px;
}

.brand-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 52px;
  min-height: 36px;
  padding: 0 14px;
  border-radius: 999px;
  background: var(--app-gradient);
  color: #ffffff;
  font-size: 22px;
  font-weight: 800;
  letter-spacing: -0.08em;
  text-decoration: none;
  box-shadow: 0 14px 28px rgba(6, 182, 212, 0.24);
}

.sidebar-nav {
  display: grid;
  gap: 8px;
}

/* 侧边栏 CTA：保持原“创建简历”的视觉权重（蓝底白字、高圆角、加号图标） */
.sidebar-create-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 46px;
  padding: 0 18px;
  border: 0;
  border-radius: var(--app-radius-pill);
  background: var(--app-gradient);
  color: #ffffff;
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0.02em;
  cursor: pointer;
  box-shadow: 0 14px 28px rgba(6, 182, 212, 0.24);
  transition:
    transform 0.3s ease,
    box-shadow 0.3s ease;
}

.sidebar-create-button:hover {
  transform: translateY(-2px);
  box-shadow: 0 20px 42px rgba(6, 182, 212, 0.32);
}

.sidebar-create-icon {
  font-size: 18px;
  line-height: 1;
  font-weight: 700;
}

.sidebar-item {
  display: flex;
  align-items: center;
  gap: 14px;
  min-height: 48px;
  padding: 0 14px;
  border: 1px solid transparent;
  border-radius: 16px;
  color: var(--app-muted-strong);
  font-size: 15px;
  text-decoration: none;
  transition:
    background-color 0.24s ease,
    border-color 0.24s ease,
    color 0.24s ease,
    transform 0.24s ease,
    box-shadow 0.24s ease;
}

.sidebar-item.active {
  border-color: rgba(6, 182, 212, 0.14);
  background: linear-gradient(
    135deg,
    rgba(34, 211, 238, 0.12),
    rgba(6, 182, 212, 0.08)
  );
  color: var(--app-primary-strong);
  font-weight: 700;
  box-shadow: 0 10px 24px rgba(6, 182, 212, 0.08);
}

.sidebar-item:hover {
  transform: translateX(3px);
  border-color: rgba(148, 163, 184, 0.18);
  background: rgba(255, 255, 255, 0.78);
}

.sidebar-icon {
  width: 24px;
  text-align: center;
  font-size: 12px;
  font-weight: 800;
  letter-spacing: 0.04em;
}

.history-box {
  display: grid;
  gap: 14px;
  padding: 16px;
  border: 1px solid rgba(148, 163, 184, 0.18);
  border-radius: 22px;
  background: rgba(248, 250, 252, 0.72);
}

.history-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--app-muted-strong);
  font-size: 14px;
  font-weight: 700;
}

.history-header button {
  width: 32px;
  height: 32px;
  border: 1px solid rgba(148, 163, 184, 0.2);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.82);
  color: var(--app-muted-strong);
  font-size: 28px;
  cursor: pointer;
  line-height: 1;
  box-shadow: var(--app-shadow-sm);
}

.history-box p,
.sidebar-user p,
.topbar-user span {
  margin: 0;
  color: var(--app-muted);
  font-size: 13px;
  line-height: 1.7;
}

.sidebar-user {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px;
  border: 1px solid rgba(148, 163, 184, 0.18);
  border-radius: 22px;
  background: rgba(255, 255, 255, 0.72);
  box-shadow: var(--app-shadow-sm);
}

.user-avatar {
  width: 46px;
  height: 46px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: var(--app-gradient);
  color: #ffffff;
  font-weight: 700;
  box-shadow: 0 14px 28px rgba(6, 182, 212, 0.24);
}

.user-meta {
  display: grid;
  min-width: 0;
}

/* 邮箱等长串不可断行，超宽时省略号截断，避免把侧边栏撑破 */
.user-meta p {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.user-action {
  margin-left: auto;
  border: 1px solid rgba(148, 163, 184, 0.18);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.82);
  color: var(--app-muted-strong);
  cursor: pointer;
  min-height: 36px;
  padding: 0 12px;
}

.workspace-main {
  display: grid;
  grid-template-rows: auto 1fr;
  border: 1px solid var(--app-border);
  border-radius: 30px;
  background: rgba(255, 255, 255, 0.58);
  box-shadow: var(--app-shadow-md);
  overflow: clip;
  backdrop-filter: blur(22px) saturate(160%);
  -webkit-backdrop-filter: blur(22px) saturate(160%);
  /* 入场：比侧边栏稍晚，形成层次感 */
  animation: fade-in-up 0.55s cubic-bezier(0.16, 1, 0.3, 1) 0.12s both;
}

.workspace-topbar {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  min-height: 70px;
  padding: 18px 28px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.14);
  background: rgba(248, 250, 252, 0.72);
  backdrop-filter: blur(18px) saturate(140%);
}

.topbar-actions {
  display: flex;
  gap: 10px;
}

.icon-button {
  width: 34px;
  height: 34px;
  border: 1px solid rgba(148, 163, 184, 0.18);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.72);
  color: var(--app-muted-strong);
  font-size: 15px;
  font-weight: 700;
  cursor: pointer;
  box-shadow: var(--app-shadow-sm);
}

.page-title {
  text-align: center;
}

.page-title h1 {
  margin: 0;
  color: var(--app-text);
  font-size: 28px;
  font-weight: 700;
  letter-spacing: -0.03em;
}

.topbar-right {
  display: flex;
  justify-content: flex-end;
}

.topbar-link {
  color: var(--app-primary);
  text-decoration: none;
  font-weight: 700;
}

.topbar-user {
  display: grid;
  text-align: right;
}

.workspace-content {
  padding: 24px;
  min-width: 0;
}

@media (max-width: 1100px) {
  .workspace-layout {
    grid-template-columns: 1fr;
    padding: 0;
    gap: 0;
  }

  .sidebar-panel {
    display: none;
  }

  .workspace-main {
    border-radius: 0;
    border-left: 0;
    border-right: 0;
    border-bottom: 0;
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
