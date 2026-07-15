import { reactive, ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';

import { createResumeFormState } from '../utils/resume';
import { useResumeGeneration } from './useResumeGeneration';

function createForm(overrides: Partial<ReturnType<typeof createResumeFormState>> = {}) {
  return reactive({
    ...createResumeFormState(),
    fullName: '张三',
    background: '后端工程师',
    targetRole: '平台工程师',
    skillsText: 'TypeScript, Node.js',
    ...overrides,
  });
}

function createSseStream(frames: string[]) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(frame));
      }
      controller.close();
    },
  });
}

describe('useResumeGeneration', () => {
  it('blocks generation when the form is incomplete', async () => {
    const errorMessage = ref('');
    const statusMessage = ref('');
    const generation = useResumeGeneration({
      form: createForm({ skillsText: '' }),
      token: ref('token-1'),
      clearAuth: vi.fn(),
      errorMessage,
      statusMessage,
      syncSystemContext: vi.fn(),
      seedGeneratedConversation: vi.fn(),
      fetchFn: vi.fn(),
    });

    await generation.generateResume();

    expect(errorMessage.value).toContain('生成需要填写姓名');
    expect(generation.generating.value).toBe(false);
  });

  it('streams variants and seeds the conversation after success', async () => {
    const errorMessage = ref('');
    const statusMessage = ref('');
    const syncSystemContext = vi.fn(async () => 'conv-1');
    const seedGeneratedConversation = vi.fn(async () => undefined);
    const fetchFn = vi.fn(async () => {
      return {
        status: 200,
        ok: true,
        body: createSseStream([
          'event: start\ndata: {"requestId":"req-1"}\n\n',
          'event: progress\ndata: {"progress":35,"stage":"generating"}\n\n',
          'event: chunk\ndata: {"text":"正在生成"}\n\n',
          'event: done\ndata: {"variants":[{"id":"v1","summary":"总结","experience":[],"projects":[],"skills":["TypeScript"]}]}\n\n',
        ]),
      } as Response;
    });

    const generation = useResumeGeneration({
      form: createForm(),
      token: ref('token-1'),
      clearAuth: vi.fn(),
      errorMessage,
      statusMessage,
      syncSystemContext,
      seedGeneratedConversation,
      fetchFn,
    });

    await generation.generateResume();

    expect(syncSystemContext).toHaveBeenCalledTimes(1);
    expect(seedGeneratedConversation).toHaveBeenCalledTimes(1);
    expect(generation.streamProgress.value).toBe(100);
    expect(generation.streamPreview.value).toBe('正在生成');
    expect(generation.resumeVariants.value).toHaveLength(1);
    expect(generation.selectedVariantMarkdown.value).toContain('## 核心技能');
    expect(statusMessage.value).toBe('简历已生成，并已写入会话，后续可以继续追问。');
  });

  it('surfaces retry errors when no previous query exists', async () => {
    const errorMessage = ref('');
    const statusMessage = ref('');
    const generation = useResumeGeneration({
      form: createForm(),
      token: ref('token-1'),
      clearAuth: vi.fn(),
      errorMessage,
      statusMessage,
      syncSystemContext: vi.fn(),
      seedGeneratedConversation: vi.fn(),
      fetchFn: vi.fn(),
    });

    await generation.retryGenerate();

    expect(errorMessage.value).toBe('当前没有可重试的生成请求。');
  });

  it('clears auth on 401 stream responses', async () => {
    const errorMessage = ref('');
    const statusMessage = ref('');
    const clearAuth = vi.fn();
    const generation = useResumeGeneration({
      form: createForm(),
      token: ref('token-1'),
      clearAuth,
      errorMessage,
      statusMessage,
      syncSystemContext: vi.fn(async () => 'conv-1'),
      seedGeneratedConversation: vi.fn(),
      fetchFn: vi.fn(async () => ({ status: 401, ok: false, body: null } as Response)),
    });

    await generation.generateResume();

    expect(clearAuth).toHaveBeenCalledTimes(1);
    expect(errorMessage.value).toBe('登录状态已过期，请重新登录。');
  });

  it('cancels in-flight generation requests', async () => {
    const errorMessage = ref('');
    const statusMessage = ref('');
    const fetchFn = vi.fn((_: string, init?: RequestInit) => {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    });

    const generation = useResumeGeneration({
      form: createForm(),
      token: ref('token-1'),
      clearAuth: vi.fn(),
      errorMessage,
      statusMessage,
      syncSystemContext: vi.fn(async () => 'conv-1'),
      seedGeneratedConversation: vi.fn(),
      fetchFn,
    });

    const task = generation.generateResume();
    await Promise.resolve();
    generation.cancelGenerate();
    await task;

    expect(statusMessage.value).toBe('生成已取消。');
    expect(generation.generating.value).toBe(false);
  });
});
