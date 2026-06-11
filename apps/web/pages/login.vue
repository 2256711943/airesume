<script setup lang="ts">
import { useAuth } from '../composables/useAuth';

const { login, token, initAuth } = useAuth();

await initAuth();

if (token.value) {
  await navigateTo('/resume');
}

const form = reactive({
  email: 'user@example.com',
  password: 'secret123',
});

const loading = ref(false);
const errorMessage = ref('');

const submit = async () => {
  loading.value = true;
  errorMessage.value = '';

  try {
    await login(form.email, form.password);
    await navigateTo('/resume');
  } catch {
    errorMessage.value = '登录失败，请检查邮箱和密码。';
  } finally {
    loading.value = false;
  }
};
</script>

<template>
  <section class="login-page">
    <article class="login-copy">
      <p class="eyebrow">
        Resume MVP
      </p>
      <h2>登录后进入简历工作台</h2>
      <p>默认测试账号已写入本地数据库，登录后即可进入 AI 简历生成页面。</p>
    </article>

    <form
      class="login-card"
      @submit.prevent="submit"
    >
      <div class="field">
        <label for="email">邮箱</label>
        <input
          id="email"
          v-model="form.email"
          type="email"
          autocomplete="username"
          required
        >
      </div>

      <div class="field">
        <label for="password">密码</label>
        <input
          id="password"
          v-model="form.password"
          type="password"
          autocomplete="current-password"
          required
        >
      </div>

      <p
        v-if="errorMessage"
        class="error-text"
      >
        {{ errorMessage }}
      </p>

      <button
        class="submit-button"
        type="submit"
        :disabled="loading"
      >
        {{ loading ? '登录中...' : '登录并进入简历助手' }}
      </button>

      <p class="hint">
        默认测试账号：`user@example.com / secret123`
      </p>
    </form>
  </section>
</template>

<style scoped>
.login-page {
  max-width: 980px;
  display: grid;
  grid-template-columns: 1fr 440px;
  gap: 24px;
  align-items: start;
}

.login-copy,
.login-card {
  background: #ffffff;
  border-radius: 24px;
  box-shadow: 0 12px 34px rgba(21, 30, 55, 0.08);
}

.login-copy {
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

.login-copy h2 {
  margin: 0;
  color: #2f3747;
  font-size: 32px;
}

.login-copy p:last-child {
  margin: 14px 0 0;
  color: #7f889b;
  line-height: 1.8;
}

.login-card {
  display: grid;
  gap: 16px;
  padding: 24px;
}

.field {
  display: grid;
  gap: 8px;
}

.field label {
  color: #31394b;
  font-size: 14px;
  font-weight: 700;
}

.field input {
  min-height: 48px;
  padding: 0 16px;
  border: 1px solid #e7ebf3;
  border-radius: 14px;
  color: #2f3747;
  font: inherit;
  transition: all 0.2s ease;
}

.field input:focus {
  outline: none;
  border-color: #cfd7ff;
  box-shadow: 0 0 0 3px rgba(59, 92, 255, 0.08);
}

.submit-button {
  min-height: 54px;
  border: 0;
  border-radius: 16px;
  background: linear-gradient(135deg, #3a58f5 0%, #3f63ff 100%);
  color: #ffffff;
  font: inherit;
  font-weight: 700;
  cursor: pointer;
}

.submit-button:disabled {
  opacity: 0.7;
  cursor: wait;
}

.error-text {
  margin: 0;
  color: #dc2626;
  font-size: 14px;
}

.hint {
  margin: 0;
  color: #98a1b2;
  font-size: 13px;
}

@media (max-width: 900px) {
  .login-page {
    grid-template-columns: 1fr;
  }
}
</style>
