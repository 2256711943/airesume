export default defineNuxtConfig({
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
