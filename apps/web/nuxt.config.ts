export default defineNuxtConfig({
  compatibilityDate: '2026-05-21',
  telemetry: false,
  devServer: {
    host: '127.0.0.1',
    port: 3000,
  },
  devtools: { enabled: true },
  css: ['~/assets/css/main.css'],
  app: {
    head: {
      title: 'AI 运营内容助手',
      meta: [
        {
          name: 'description',
          content: 'AI Content Ops Assistant',
        },
      ],
    },
  },
});
