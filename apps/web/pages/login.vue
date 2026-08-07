<script setup lang="ts">
/**
 * @description 独立登录页：现代全屏视觉，支持真实账号登录（后端可用时），
 * 后端不可用时自动回退到本地模拟登录，登录成功统一跳转首页。
 */
import { reactive, ref } from "vue";
import { getStatusCode } from "../utils/auth";
import { useAuth } from "../composables/useAuth";

definePageMeta({ layout: false });

const { login, mockLogin, token, initAuth } = useAuth();

await initAuth();

if (token.value) {
  await navigateTo("/");
}

const form = reactive({
  username: "user@example.com",
  password: "secret123",
});

const loading = ref(false);
const errorMessage = ref("");

const submit = async () => {
  loading.value = true;
  errorMessage.value = "";

  try {
    // 优先使用真实账号登录（后端存在时会校验邮箱与密码）。
    await login(form.username, form.password);
  } catch (error) {
    // 仅在后端不可用（网络错误，非业务 4xx/5xx）时回退到模拟登录，
    // 保证纯前端演示可以顺畅进入首页。
    if (getStatusCode(error) === undefined) {
      await mockLogin(form.username);
    } else {
      errorMessage.value = "登录失败，请检查用户名和密码。";
    }
  } finally {
    loading.value = false;
  }

  if (!errorMessage.value) {
    await navigateTo("/");
  }
};

const submitMock = async () => {
  loading.value = true;
  errorMessage.value = "";
  mockLogin(form.username);
  loading.value = false;
  await navigateTo("/");
};
</script>

<template>
  <main class="login-page">
    <div class="orb orb-one" />
    <div class="orb orb-two" />
    <div class="orb orb-three" />

    <section class="login-shell">
      <article class="login-copy">
        <div class="brand-row">
          <span class="brand-mark">UP</span>
          <span class="brand-name">AI 运营内容助手</span>
        </div>

        <h2>让 AI 帮你写出更好的简历</h2>
        <p class="login-lead">
          登录后进入对话首页，与 UP AI
          对话式协作，一键生成技术版、业务版、综合版三版简历，并导出 PDF。
        </p>

        <ul class="feature-list">
          <li>对话式简历撰写与优化</li>
          <li>三版风格简历一键生成</li>
          <li>Markdown / PDF 便捷导出</li>
        </ul>
      </article>

      <form class="login-card" @submit.prevent="submit">
        <p class="form-kicker">Welcome back</p>
        <h3>登录</h3>

        <label class="field">
          <span>用户名</span>
          <el-input
            id="username"
            v-model="form.username"
            type="text"
            autocomplete="username"
            size="large"
            placeholder="请输入用户名 / 邮箱"
          />
        </label>

        <label class="field">
          <span>密码</span>
          <el-input
            id="password"
            v-model="form.password"
            type="password"
            show-password
            autocomplete="current-password"
            size="large"
            placeholder="请输入密码"
          />
        </label>

        <p v-if="errorMessage" class="error-text">
          {{ errorMessage }}
        </p>

        <el-button
          type="primary"
          native-type="submit"
          :loading="loading"
          size="large"
          class="submit-button"
        >
          {{ loading ? "登录中..." : "登录" }}
        </el-button>

        <div class="divider">
          <span>或</span>
        </div>

        <el-button
          size="large"
          class="mock-button"
          :disabled="loading"
          @click="submitMock"
        >
          一键体验（模拟登录）
        </el-button>

        <p class="hint">
          测试账号：user@example.com /
          secret123；后端未启动时可用「一键体验」直接进入。
        </p>
      </form>
    </section>
  </main>
</template>

<style scoped>
.login-page {
  position: relative;
  min-height: 100vh;
  display: grid;
  place-items: center;
  overflow: hidden;
  padding: 32px 20px;
  background:
    radial-gradient(
      circle at 15% 12%,
      rgba(53, 91, 255, 0.22),
      transparent 34%
    ),
    radial-gradient(
      circle at 85% 80%,
      rgba(40, 183, 202, 0.2),
      transparent 32%
    ),
    linear-gradient(135deg, #0f172a 0%, #1e2a4a 55%, #16223f 100%);
  color: #eef2ff;
}

.orb {
  position: absolute;
  border-radius: 50%;
  filter: blur(70px);
  opacity: 0.5;
  pointer-events: none;
}

.orb-one {
  width: 340px;
  height: 340px;
  top: -80px;
  left: -60px;
  background: #06b6d4;
}

.orb-two {
  width: 280px;
  height: 280px;
  right: -40px;
  bottom: -60px;
  background: #2dd4bf;
}

.orb-three {
  width: 180px;
  height: 180px;
  right: 18%;
  top: 8%;
  background: #7c5cff;
  opacity: 0.35;
}

.login-shell {
  position: relative;
  z-index: 1;
  width: min(1040px, 100%);
  display: grid;
  grid-template-columns: 1.15fr 0.85fr;
  gap: 28px;
  align-items: center;
}

.login-copy,
.login-card {
  border-radius: 28px;
  backdrop-filter: blur(18px);
}

.login-copy {
  padding: 36px;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.14);
  box-shadow: 0 30px 70px rgba(5, 10, 30, 0.35);
}

.brand-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 26px;
}

.brand-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 42px;
  height: 42px;
  border-radius: 14px;
  background: linear-gradient(135deg, #06b6d4, #2dd4bf);
  color: #ffffff;
  font-size: 18px;
  font-weight: 800;
  letter-spacing: -0.06em;
  box-shadow: 0 10px 24px rgba(53, 91, 255, 0.4);
}

.brand-name {
  font-size: 15px;
  font-weight: 700;
  color: #dbe4ff;
}

.login-copy h2 {
  margin: 0;
  font-size: clamp(30px, 4vw, 44px);
  line-height: 1.15;
  letter-spacing: -0.02em;
  color: #ffffff;
}

.login-lead {
  margin: 18px 0 0;
  color: #b8c4e8;
  font-size: 15px;
  line-height: 1.9;
}

.feature-list {
  display: grid;
  gap: 12px;
  margin: 26px 0 0;
  padding: 0;
  list-style: none;
  color: #dbe4ff;
  font-size: 14px;
}

.feature-list li {
  display: flex;
  align-items: center;
  gap: 10px;
}

.feature-list li::before {
  content: "";
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: linear-gradient(135deg, #06b6d4, #2dd4bf);
  box-shadow: 0 0 12px rgba(53, 91, 255, 0.7);
}

.login-card {
  display: grid;
  gap: 16px;
  padding: 34px;
  background: rgba(255, 255, 255, 0.95);
  border: 1px solid rgba(255, 255, 255, 0.4);
  box-shadow: 0 34px 80px rgba(5, 10, 30, 0.45);
  color: #1f2a44;
}

.form-kicker {
  margin: 0;
  color: #06b6d4;
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.18em;
  text-transform: uppercase;
}

.login-card h3 {
  margin: 4px 0 6px;
  font-size: 28px;
  color: #1f2a44;
}

.field {
  display: grid;
  gap: 8px;
}

.field > span {
  color: #31394b;
  font-size: 14px;
  font-weight: 700;
}

.submit-button {
  width: 100%;
  margin-top: 4px;
}

.mock-button {
  width: 100%;
}

.divider {
  display: flex;
  align-items: center;
  gap: 12px;
  color: #98a1b2;
  font-size: 12px;
}

.divider::before,
.divider::after {
  content: "";
  flex: 1;
  height: 1px;
  background: #e6eaf4;
}

.error-text {
  margin: 0;
  color: #dc2626;
  font-size: 14px;
}

.hint {
  margin: 0;
  color: #98a1b2;
  font-size: 12px;
  line-height: 1.7;
}

@media (max-width: 860px) {
  .login-shell {
    grid-template-columns: 1fr;
  }

  .login-copy {
    padding: 26px;
  }
}
</style>
