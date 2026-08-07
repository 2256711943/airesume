import { useAuth } from "../composables/useAuth";

export default defineNuxtRouteMiddleware(async (to) => {
  const publicPaths = new Set(["/login"]);
  const { initAuth, token } = useAuth();

  await initAuth();

  if (!publicPaths.has(to.path) && !token.value) {
    return navigateTo("/login");
  }
});
