<script setup lang="ts">
/** 兼容旧登录入口路径，统一跳转到当前登录页。 */
await navigateTo('/login', { replace: true });
</script>
