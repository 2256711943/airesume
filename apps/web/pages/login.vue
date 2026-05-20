<script setup lang="ts">
import { useAuth } from '../composables/useAuth';

const { login, token, initAuth } = useAuth();

await initAuth();

if (token.value) {
  await navigateTo('/products');
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
    await navigateTo('/products');
  } catch {
    errorMessage.value = '登录失败，请检查邮箱和密码。';
  } finally {
    loading.value = false;
  }
};
</script>

<template>
  <section class="auth-page">
    <div class="auth-copy">
      <p class="eyebrow">Local MVP</p>
      <h1>连接本地 SQLite 登录链路</h1>
      <p class="muted">
        当前账号已写入本地数据库 `dev.db`。登录后即可访问受保护的商品、文案与指标页面。
      </p>
    </div>

    <form class="auth-card" @submit.prevent="submit">
      <div class="field">
        <label for="email">邮箱</label>
        <input id="email" v-model="form.email" type="email" autocomplete="username" required />
      </div>

      <div class="field">
        <label for="password">密码</label>
        <input
          id="password"
          v-model="form.password"
          type="password"
          autocomplete="current-password"
          required
        />
      </div>

      <p v-if="errorMessage" class="error-text">{{ errorMessage }}</p>

      <button class="button button-primary" type="submit" :disabled="loading">
        {{ loading ? '登录中...' : '登录并进入工作台' }}
      </button>

      <p class="hint">
        默认测试账号：`user@example.com / secret123`
      </p>
    </form>
  </section>
</template>
