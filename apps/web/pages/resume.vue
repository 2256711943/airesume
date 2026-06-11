<script setup lang="ts">
import MarkdownIt from 'markdown-it';
import { useApiFetch } from '../composables/useApiFetch';
import { useAuth } from '../composables/useAuth';

const API_BASE_URL = 'http://127.0.0.1:3001';

type ResumeMode = 'technical' | 'business' | 'hybrid';
type ChatRole = 'system' | 'user' | 'assistant';
type ChatMessageKind = 'text' | 'form';

interface ResumeExperience {
  company: string;
  role: string;
  highlights: string[];
}

interface ResumeProject {
  name: string;
  highlights: string[];
}

interface ResumeVariant {
  id: string;
  mode?: ResumeMode;
  summary: string;
  experience: ResumeExperience[];
  projects: ResumeProject[];
  skills: string[];
}

interface ApiEnvelope<T> {
  success: boolean;
  data: T;
  error: { code: string; message: string } | null;
  requestId: string;
}

interface ConversationDto {
  id: string;
  title: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

interface ConversationMessageDto {
  id: string;
  role: string;
  content: string;
  intent: string | null;
  agentName: string | null;
  createdAt: string;
}

interface ChatResponseData {
  conversationId: string;
  agentRunId: string;
  createdConversation: boolean;
  message: ConversationMessageDto;
  assistantMessage?: ConversationMessageDto;
  routeDecision: {
    intent: string;
    selectedAgent: string;
    reason: string;
  };
  recentMessages: ConversationMessageDto[];
}

interface StreamStartPayload {
  requestId?: string;
  taskId?: string;
}

interface StreamProgressPayload extends StreamStartPayload {
  progress?: number;
  stage?: string;
}

interface StreamChunkPayload extends StreamStartPayload {
  text?: string;
}

interface StreamDonePayload extends StreamStartPayload {
  variants?: unknown;
}

interface StreamErrorPayload extends StreamStartPayload {
  code?: string;
  message?: string;
}

interface ChatMessage {
  id: string;
  role: ChatRole;
  kind: ChatMessageKind;
  content: string;
  streaming?: boolean;
}

const { token, clearAuth } = useAuth();
const markdown = new MarkdownIt({
  breaks: true,
  linkify: true,
  html: false,
});

const variantLabels = ['技术版', '业务版', '综合版'];
const quickTags = ['简历诊断', '简历翻译', '项目亮点优化', '职业规划'];

const form = reactive({
  fullName: '',
  background: '',
  targetRole: '',
  targetDescription: '',
  skillsText: '',
  targetSkillsText: '',
  experienceText: '',
  projectText: '',
  tone: 'professional',
  language: 'zh-CN',
});

const chatMessages = ref<ChatMessage[]>([
  {
    id: 'resume-form',
    role: 'system',
    kind: 'form',
    content: '请先填写这张简历表单。你可以填写后生成三版简历，也可以跳过直接开始对话。',
  },
]);

const chatInput = ref('');
const conversationId = ref('');
const errorMessage = ref('');
const statusMessage = ref('');
const generating = ref(false);
const sendingMessage = ref(false);
const streamProgress = ref(0);
const streamStage = ref('');
const streamPreview = ref('');
const resumeVariants = ref<ResumeVariant[]>([]);
const selectedVariantIndex = ref(0);
const currentStreamController = ref<AbortController | null>(null);
const lastGenerateQuery = ref('');
const lastSyncedSystemContext = ref('');
const chatComposerRef = ref<HTMLTextAreaElement | null>(null);

const splitEntries = (value: string): string[] => {
  return value
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
};

const parseExperienceLines = (value: string): ResumeExperience[] => {
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map((line) => {
      const [company = '', role = '', highlightText = ''] = line.split('|').map((item) => item.trim());
      if (!company || !role) {
        return null;
      }

      const highlights = highlightText
        .split(';')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);

      return {
        company,
        role,
        highlights: highlights.length > 0 ? highlights : [`负责 ${role} 相关工作`],
      };
    })
    .filter((item): item is ResumeExperience => item !== null);
};

const parseProjectLines = (value: string): ResumeProject[] => {
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map((line) => {
      const [name = '', highlightText = ''] = line.split('|').map((item) => item.trim());
      if (!name) {
        return null;
      }

      const highlights = highlightText
        .split(';')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);

      return {
        name,
        highlights: highlights.length > 0 ? highlights : ['完成了该项目的关键交付'],
      };
    })
    .filter((item): item is ResumeProject => item !== null);
};

const isResumeVariant = (value: unknown): value is ResumeVariant => {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const item = value as Record<string, unknown>;
  return (
    typeof item.id === 'string' &&
    typeof item.summary === 'string' &&
    Array.isArray(item.experience) &&
    Array.isArray(item.projects) &&
    Array.isArray(item.skills)
  );
};

const parseVariants = (value: unknown): ResumeVariant[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(isResumeVariant).map((item) => ({
    id: item.id,
    mode: item.mode,
    summary: item.summary,
    experience: item.experience.map((exp) => ({
      company: String((exp as Record<string, unknown>).company ?? ''),
      role: String((exp as Record<string, unknown>).role ?? ''),
      highlights: Array.isArray((exp as Record<string, unknown>).highlights)
        ? ((exp as Record<string, unknown>).highlights as unknown[]).map((highlight) => String(highlight))
        : [],
    })),
    projects: item.projects.map((project) => ({
      name: String((project as Record<string, unknown>).name ?? ''),
      highlights: Array.isArray((project as Record<string, unknown>).highlights)
        ? ((project as Record<string, unknown>).highlights as unknown[]).map((highlight) => String(highlight))
        : [],
    })),
    skills: item.skills.map((skill) => String(skill)),
  }));
};

const selectedVariant = computed(() => resumeVariants.value[selectedVariantIndex.value] ?? null);
const hasGeneratedVariants = computed(() => resumeVariants.value.length > 0);
const activeVariantLabel = computed(
  () => variantLabels[selectedVariantIndex.value] ?? `版本 ${selectedVariantIndex.value + 1}`,
);
const selectedVariantMarkdown = computed(() =>
  selectedVariant.value ? buildVariantMarkdown(selectedVariant.value, activeVariantLabel.value) : '',
);
const selectedVariantFileName = computed(() => {
  const label = variantLabels[selectedVariantIndex.value] ?? `版本-${selectedVariantIndex.value + 1}`;
  return `${form.targetRole.trim() || 'resume'}-${label}.md`;
});
const streamStageLabel = computed(() => {
  const stageLabelMap: Record<string, string> = {
    planning: '规划中',
    generating: '生成中',
    post_processing: '整理中',
    idle: '空闲',
  };

  if (!streamStage.value) {
    return '等待生成';
  }

  return stageLabelMap[streamStage.value] ?? streamStage.value;
});
const generationReady = computed(() => {
  return (
    form.fullName.trim().length > 0 &&
    form.background.trim().length > 0 &&
    form.targetRole.trim().length > 0 &&
    splitEntries(form.skillsText).length > 0
  );
});
const currentChatTitle = computed(() => form.targetRole.trim() || 'UP AI 简历对话');
const formSummaryLines = computed(() => {
  return [
    form.fullName.trim() ? `姓名：${form.fullName.trim()}` : '姓名：未填写',
    form.targetRole.trim() ? `目标岗位：${form.targetRole.trim()}` : '目标岗位：未填写',
    form.background.trim() ? `背景：${form.background.trim()}` : '背景：未填写',
    splitEntries(form.skillsText).length > 0 ? `技能：${splitEntries(form.skillsText).join(' / ')}` : '技能：未填写',
  ];
});

const renderMarkdown = (content: string): string => markdown.render(content || '');

const buildGenerateQuery = (): string => {
  const profile = {
    fullName: form.fullName.trim(),
    background: form.background.trim(),
    skills: splitEntries(form.skillsText),
    experiences: parseExperienceLines(form.experienceText),
    projects: parseProjectLines(form.projectText),
  };

  const targetJob = {
    title: form.targetRole.trim(),
    description: form.targetDescription.trim(),
    mustHaveSkills: splitEntries(form.targetSkillsText),
  };

  return new URLSearchParams({
    profile: JSON.stringify(profile),
    targetJob: JSON.stringify(targetJob),
    tone: form.tone.trim() || 'professional',
    language: form.language.trim() || 'zh-CN',
    variants: '3',
  }).toString();
};

const buildSystemContextMessage = (): string => {
  const lines = [
    'SYSTEM / UP AI 简历上下文',
    form.fullName.trim() ? `- 姓名：${form.fullName.trim()}` : '- 姓名：未填写',
    form.targetRole.trim() ? `- 目标岗位：${form.targetRole.trim()}` : '- 目标岗位：未填写',
    form.background.trim() ? `- 背景：${form.background.trim()}` : '- 背景：未填写',
    splitEntries(form.skillsText).length > 0
      ? `- 技能：${splitEntries(form.skillsText).join(' / ')}`
      : '- 技能：未填写',
    splitEntries(form.targetSkillsText).length > 0
      ? `- 岗位要求：${splitEntries(form.targetSkillsText).join(' / ')}`
      : '- 岗位要求：未填写',
    parseExperienceLines(form.experienceText).length > 0
      ? `- 工作经历：${parseExperienceLines(form.experienceText).length} 条`
      : '- 工作经历：未填写',
    parseProjectLines(form.projectText).length > 0
      ? `- 项目经历：${parseProjectLines(form.projectText).length} 条`
      : '- 项目经历：未填写',
    '说明：后续回答应优先结合上述上下文；如果信息不足，先追问再给方案。',
  ];

  return lines.join('\n');
};

const buildVariantMarkdown = (variant: ResumeVariant, label: string): string => {
  const experienceSection = variant.experience
    .map((item) => {
      const highlights = item.highlights.map((highlight) => `- ${highlight}`).join('\n');
      return `### ${item.company} | ${item.role}\n${highlights}`;
    })
    .join('\n\n');

  const projectSection = variant.projects
    .map((item) => {
      const highlights = item.highlights.map((highlight) => `- ${highlight}`).join('\n');
      return `### ${item.name}\n${highlights}`;
    })
    .join('\n\n');

  return [
    `# ${label}`,
    '',
    '## 个人总结',
    variant.summary || '暂无摘要',
    '',
    '## 工作经历',
    experienceSection || '- 暂无工作经历',
    '',
    '## 项目经历',
    projectSection || '- 暂无项目经历',
    '',
    '## 核心技能',
    variant.skills.join(' / ') || '暂无技能',
  ].join('\n');
};

const buildAllVariantsMarkdown = (): string => {
  if (resumeVariants.value.length === 0) {
    return '当前还没有生成结果。';
  }

  return resumeVariants.value
    .map((variant, index) => {
      const label = variantLabels[index] ?? `版本 ${index + 1}`;
      return buildVariantMarkdown(variant, label);
    })
    .join('\n\n---\n\n');
};

const appendChatMessage = (role: ChatRole, content: string, streaming = false) => {
  chatMessages.value.push({
    id: `${role}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    role,
    kind: 'text',
    content,
    streaming,
  });
};

const updateChatMessage = (messageId: string, content: string, streaming = false) => {
  const target = chatMessages.value.find((item) => item.id === messageId);
  if (!target) {
    return;
  }

  target.content = content;
  target.streaming = streaming;
};

const ensureConversation = async (): Promise<string> => {
  if (conversationId.value) {
    return conversationId.value;
  }

  const response = await useApiFetch<ApiEnvelope<ConversationDto>>('/conversations', {
    method: 'POST',
    body: {
      title: currentChatTitle.value,
    },
  });

  if (!response.success || !response.data) {
    throw new Error(response.error?.message || '创建会话失败');
  }

  conversationId.value = response.data.id;
  return conversationId.value;
};

const appendConversationMessage = async (
  conversation: string,
  role: ChatRole | 'tool',
  content: string,
  intent?: string,
  agentName?: string,
) => {
  await useApiFetch<ApiEnvelope<ConversationMessageDto>>(`/conversations/${conversation}/messages`, {
    method: 'POST',
    body: {
      role,
      content,
      intent,
      agentName,
    },
  });
};

const syncSystemContext = async (): Promise<string> => {
  const content = buildSystemContextMessage();
  const conversation = await ensureConversation();

  if (lastSyncedSystemContext.value === content) {
    return conversation;
  }

  await appendConversationMessage(conversation, 'system', content, 'resume_context', 'resume_workbench');
  lastSyncedSystemContext.value = content;
  return conversation;
};

const seedGeneratedConversation = async () => {
  const conversation = await syncSystemContext();
  const requestMessage = '请基于当前表单信息生成技术版、业务版和综合版三版简历。';
  const assistantSnapshot = buildAllVariantsMarkdown();

  await appendConversationMessage(conversation, 'user', requestMessage, 'resume_generation');
  await appendConversationMessage(conversation, 'assistant', assistantSnapshot, 'resume_generation');

  appendChatMessage('user', requestMessage);
  appendChatMessage('assistant', assistantSnapshot);
};

const handleStreamEvent = (eventName: string, payload: Record<string, unknown>) => {
  const event = eventName as 'start' | 'progress' | 'chunk' | 'done' | 'error' | 'canceled';

  if (event === 'start') {
    streamProgress.value = 0;
    streamStage.value = 'planning';
    return;
  }

  if (event === 'progress') {
    const progressPayload = payload as StreamProgressPayload;
    streamProgress.value = Math.max(0, Math.min(100, Number(progressPayload.progress ?? 0)));
    streamStage.value = typeof progressPayload.stage === 'string' ? progressPayload.stage : streamStage.value;
    return;
  }

  if (event === 'chunk') {
    const chunkPayload = payload as StreamChunkPayload;
    if (typeof chunkPayload.text === 'string') {
      streamPreview.value += chunkPayload.text;
    }
    return;
  }

  if (event === 'done') {
    const donePayload = payload as StreamDonePayload;
    streamProgress.value = 100;
    streamStage.value = 'post_processing';
    resumeVariants.value = parseVariants(donePayload.variants);
    selectedVariantIndex.value = 0;
    statusMessage.value = '简历已生成完成。';
    return;
  }

  if (event === 'error') {
    const errorPayload = payload as StreamErrorPayload;
    const code = typeof errorPayload.code === 'string' ? `[${errorPayload.code}] ` : '';
    const message =
      typeof errorPayload.message === 'string' ? errorPayload.message : '简历生成失败，请稍后重试。';
    errorMessage.value = `${code}${message}`;
    return;
  }

  if (event === 'canceled') {
    statusMessage.value = '生成已取消。';
  }
};

const consumeSseStream = async (body: ReadableStream<Uint8Array>) => {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const parseFrame = (frame: string) => {
    const lines = frame.split('\n');
    let eventName = '';
    const dataParts: string[] = [];

    for (const line of lines) {
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataParts.push(line.slice(5).trim());
      }
    }

    if (!eventName || dataParts.length === 0) {
      return;
    }

    try {
      const payload = JSON.parse(dataParts.join('\n')) as Record<string, unknown>;
      handleStreamEvent(eventName, payload);
    } catch {
      // Ignore malformed SSE frames and continue consuming the stream.
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    if (!value) {
      continue;
    }

    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';

    for (const frame of frames) {
      parseFrame(frame);
    }
  }

  if (buffer.trim().length > 0) {
    parseFrame(buffer);
  }
};

const startGenerateStream = async (query: string) => {
  if (!token.value) {
    errorMessage.value = '登录状态已失效，请重新登录。';
    return;
  }

  generating.value = true;
  errorMessage.value = '';
  statusMessage.value = '';
  streamProgress.value = 0;
  streamStage.value = '';
  streamPreview.value = '';
  resumeVariants.value = [];
  selectedVariantIndex.value = 0;

  const controller = new AbortController();
  currentStreamController.value = controller;

  try {
    const response = await fetch(`${API_BASE_URL}/resume/generate/stream?${query}`, {
      method: 'GET',
      headers: {
        Accept: 'text/event-stream',
        Authorization: `Bearer ${token.value}`,
      },
      signal: controller.signal,
    });

    if (response.status === 401) {
      clearAuth();
      throw new Error('登录状态已过期，请重新登录。');
    }

    if (!response.ok) {
      throw new Error(`流式生成接口返回异常：HTTP ${response.status}`);
    }

    if (!response.body) {
      throw new Error('流式生成接口没有返回可读数据流。');
    }

    await consumeSseStream(response.body);

    if (resumeVariants.value.length > 0) {
      try {
        await seedGeneratedConversation();
        statusMessage.value = '简历已生成，并已写入会话，后续可以继续追问。';
      } catch (conversationError) {
        statusMessage.value =
          conversationError instanceof Error
            ? `简历已生成，但写入会话失败：${conversationError.message}`
            : '简历已生成，但写入会话失败。';
      }
    }
  } catch (error) {
    if (controller.signal.aborted) {
      statusMessage.value = '生成已取消。';
    } else {
      errorMessage.value = error instanceof Error ? error.message : '简历生成失败，请稍后重试。';
    }
  } finally {
    generating.value = false;
    currentStreamController.value = null;
  }
};

const generateResume = async () => {
  if (!generationReady.value) {
    errorMessage.value = '生成需要填写姓名、背景、目标岗位和至少一项技能；如果暂时不填，可以直接对话。';
    return;
  }

  lastGenerateQuery.value = buildGenerateQuery();
  await syncSystemContext();
  await startGenerateStream(lastGenerateQuery.value);
};

const retryGenerate = async () => {
  if (!lastGenerateQuery.value) {
    errorMessage.value = '当前没有可重试的生成请求。';
    return;
  }

  await syncSystemContext();
  await startGenerateStream(lastGenerateQuery.value);
};

const cancelGenerate = () => {
  currentStreamController.value?.abort();
};

const focusComposer = async () => {
  await nextTick();
  chatComposerRef.value?.focus();
};

const applyQuickPrompt = async (prompt: string) => {
  chatInput.value = prompt;
  await focusComposer();
};

const copyContent = async (content: string) => {
  await navigator.clipboard.writeText(content);
  statusMessage.value = '内容已复制到剪贴板。';
};

const exportContent = (content: string, fileName: string) => {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
  statusMessage.value = '已导出 Markdown 文件。';
};

const sendChatMessage = async () => {
  const content = chatInput.value.trim();
  if (!content || sendingMessage.value) {
    return;
  }

  chatInput.value = '';
  errorMessage.value = '';
  sendingMessage.value = true;

  const assistantMessageId = `assistant_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  try {
    const conversation = await syncSystemContext();
    appendChatMessage('user', content);
    chatMessages.value.push({
      id: assistantMessageId,
      role: 'assistant',
      kind: 'text',
      content: '正在整理回复...',
      streaming: true,
    });

    const response = await useApiFetch<ApiEnvelope<ChatResponseData>>('/chat/message', {
      method: 'POST',
      body: {
        conversationId: conversation,
        message: content,
        title: conversationId.value ? undefined : currentChatTitle.value,
        historyLimit: 12,
      },
    });

    if (!response.success || !response.data) {
      throw new Error(response.error?.message || '发送消息失败');
    }

    conversationId.value = response.data.conversationId;
    const assistantContent = response.data.assistantMessage?.content?.trim() || '我已经收到你的问题。';
    updateChatMessage(assistantMessageId, assistantContent, false);
    statusMessage.value = response.data.routeDecision?.selectedAgent
      ? `已路由到 ${response.data.routeDecision.selectedAgent}`
      : '消息已发送。';
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '发送失败，请稍后重试。';
    const assistantMessage = chatMessages.value.find((item) => item.id === assistantMessageId);
    if (assistantMessage) {
      assistantMessage.content = error instanceof Error ? error.message : '发送失败，请稍后重试。';
      assistantMessage.streaming = false;
    }
  } finally {
    sendingMessage.value = false;
  }
};

const onComposerKeydown = (event: KeyboardEvent) => {
  if (event.isComposing) {
    return;
  }

  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    void sendChatMessage();
  }
};

onBeforeUnmount(() => {
  currentStreamController.value?.abort();
});
</script>

<template>
  <section class="resume-page">
    <header class="page-header">
      <div>
        <p class="eyebrow">
          Resume Assistant
        </p>
        <h2>简历对话工作台</h2>
        <p class="page-note">
          新开对话时，系统会先把表单直接发进消息流里。你可以填写后生成三版简历，也可以跳过直接聊天。
        </p>
      </div>

      <div class="header-pills">
        <span class="status-pill">
          {{ conversationId ? '会话已建立' : '等待对话' }}
        </span>
        <span class="status-pill soft">
          {{ hasGeneratedVariants ? `已生成 ${resumeVariants.length} 个版本` : '尚未生成' }}
        </span>
      </div>
    </header>

    <p
      v-if="errorMessage"
      class="banner error-banner"
    >
      {{ errorMessage }}
    </p>

    <p
      v-if="statusMessage"
      class="banner status-banner"
    >
      {{ statusMessage }}
    </p>

    <section class="panel chat-panel">
      <div class="section-head">
        <div>
          <p class="section-kicker">
            对话窗口
          </p>
          <h3>围绕简历继续提问</h3>
        </div>

        <span class="section-tag">
          {{ conversationId ? '会话进行中' : '新对话' }}
        </span>
      </div>

      <div class="chat-window">
        <article
          v-for="message in chatMessages"
          :key="message.id"
          class="chat-message"
          :class="message.role"
        >
          <div
            v-if="message.kind === 'form'"
            class="bubble form-bubble"
          >
            <div class="form-message-head">
              <p class="form-message-kicker">
                系统表单
              </p>
              <h4>先告诉 UP AI 一些基础信息</h4>
              <p class="form-message-note">
                这张表单就是本轮对话的系统上下文入口。可以填写后生成简历，也可以直接跳过。
              </p>
            </div>

            <div class="form-grid">
              <label class="field">
                <span>姓名</span>
                <input
                  v-model="form.fullName"
                  type="text"
                  maxlength="80"
                  placeholder="例如：张三"
                >
              </label>

              <label class="field">
                <span>目标岗位</span>
                <input
                  v-model="form.targetRole"
                  type="text"
                  maxlength="100"
                  placeholder="例如：后端工程师"
                >
              </label>

              <label class="field full-width">
                <span>背景简介</span>
                <textarea
                  v-model="form.background"
                  rows="3"
                  maxlength="500"
                  placeholder="例如：3 年后端开发经验，做过高并发服务和接口优化。"
                />
              </label>

              <label class="field full-width">
                <span>技能</span>
                <input
                  v-model="form.skillsText"
                  type="text"
                  placeholder="例如：Node.js, NestJS, PostgreSQL, Redis"
                >
              </label>

              <label class="field full-width">
                <span>岗位要求</span>
                <input
                  v-model="form.targetSkillsText"
                  type="text"
                  placeholder="例如：微服务, 性能优化, 可观测性"
                >
              </label>

              <label class="field full-width">
                <span>岗位描述</span>
                <textarea
                  v-model="form.targetDescription"
                  rows="3"
                  maxlength="2000"
                  placeholder="补充岗位职责、业务场景或团队要求，便于生成更贴合的版本。"
                />
              </label>

              <label class="field full-width">
                <span>工作经历</span>
                <textarea
                  v-model="form.experienceText"
                  rows="4"
                  placeholder="每行格式：公司|岗位|亮点1;亮点2"
                />
              </label>

              <label class="field full-width">
                <span>项目经历</span>
                <textarea
                  v-model="form.projectText"
                  rows="4"
                  placeholder="每行格式：项目名|亮点1;亮点2"
                />
              </label>

              <label class="field">
                <span>语气</span>
                <select v-model="form.tone">
                  <option value="professional">
                    professional
                  </option>
                  <option value="concise">
                    concise
                  </option>
                </select>
              </label>

              <label class="field">
                <span>语言</span>
                <select v-model="form.language">
                  <option value="zh-CN">
                    zh-CN
                  </option>
                  <option value="en-US">
                    en-US
                  </option>
                </select>
              </label>
            </div>

            <div class="form-summary">
              <p class="form-summary-label">
                当前上下文预览
              </p>
              <div class="summary-chips">
                <span
                  v-for="line in formSummaryLines"
                  :key="line"
                  class="summary-chip"
                >
                  {{ line }}
                </span>
              </div>
            </div>

            <div class="action-row">
              <button
                class="primary-button"
                type="button"
                :disabled="generating || !generationReady"
                @click="generateResume"
              >
                {{ generating ? '正在生成...' : '生成三版简历' }}
              </button>

              <button
                class="secondary-button"
                type="button"
                :disabled="generating"
                @click="focusComposer"
              >
                跳过，直接对话
              </button>

              <button
                class="ghost-button"
                type="button"
                :disabled="generating || !lastGenerateQuery"
                @click="retryGenerate"
              >
                重试生成
              </button>

              <button
                class="ghost-button"
                type="button"
                :disabled="!generating"
                @click="cancelGenerate"
              >
                取消
              </button>
            </div>

            <div
              v-if="generating || streamProgress > 0"
              class="progress-box"
            >
              <div class="progress-head">
                <span>{{ streamStageLabel }}</span>
                <strong>{{ Math.round(streamProgress) }}%</strong>
              </div>
              <div class="progress-track">
                <div
                  class="progress-bar"
                  :style="{ width: `${streamProgress}%` }"
                />
              </div>
              <p
                v-if="streamPreview"
                class="progress-preview"
              >
                {{ streamPreview }}
              </p>
            </div>
          </div>

          <template v-else>
            <div class="bubble">
              <div
                v-if="message.role === 'assistant' || message.role === 'system'"
                class="markdown-body"
                v-html="renderMarkdown(message.content)"
              />
              <p
                v-else
                class="plain-message"
              >
                {{ message.content }}
              </p>
            </div>

            <div
              v-if="message.role === 'assistant' && !message.streaming"
              class="message-actions"
            >
              <button
                type="button"
                class="chip-button"
                @click="copyContent(message.content)"
              >
                复制
              </button>
              <button
                type="button"
                class="chip-button"
                @click="exportContent(message.content, 'chat-message.md')"
              >
                导出
              </button>
            </div>
          </template>
        </article>

        <article
          v-if="hasGeneratedVariants"
          class="chat-message assistant"
        >
          <div class="bubble variant-bubble">
            <div class="variant-head">
              <div>
                <p class="variant-kicker">
                  三版预览
                </p>
                <h4>技术版 / 业务版 / 综合版</h4>
              </div>
              <span class="section-tag">
                当前：{{ activeVariantLabel }}
              </span>
            </div>

            <div class="variant-tabs">
              <button
                v-for="(variant, index) in resumeVariants"
                :key="variant.id"
                type="button"
                class="variant-tab"
                :class="{ active: index === selectedVariantIndex }"
                @click="selectedVariantIndex = index"
              >
                {{ variantLabels[index] ?? `版本 ${index + 1}` }}
              </button>
            </div>

            <template v-if="selectedVariant">
              <div class="variant-summary">
                <p class="variant-label">
                  摘要
                </p>
                <p class="variant-summary-text">
                  {{ selectedVariant.summary }}
                </p>
              </div>

              <div class="variant-grid">
                <article class="variant-block">
                  <p class="variant-label">
                    核心技能
                  </p>
                  <div class="tag-list">
                    <span
                      v-for="skill in selectedVariant.skills"
                      :key="skill"
                      class="tag"
                    >
                      {{ skill }}
                    </span>
                  </div>
                </article>

                <article class="variant-block">
                  <p class="variant-label">
                    工作经历
                  </p>
                  <div class="entry-list">
                    <div
                      v-for="exp in selectedVariant.experience"
                      :key="`${exp.company}-${exp.role}`"
                      class="entry-card"
                    >
                      <strong>{{ exp.company }} · {{ exp.role }}</strong>
                      <ul>
                        <li
                          v-for="highlight in exp.highlights"
                          :key="highlight"
                        >
                          {{ highlight }}
                        </li>
                      </ul>
                    </div>
                  </div>
                </article>
              </div>

              <article class="variant-block">
                <p class="variant-label">
                  项目经历
                </p>
                <div class="entry-list">
                  <div
                    v-for="project in selectedVariant.projects"
                    :key="project.name"
                    class="entry-card"
                  >
                    <strong>{{ project.name }}</strong>
                    <ul>
                      <li
                        v-for="highlight in project.highlights"
                        :key="highlight"
                      >
                        {{ highlight }}
                      </li>
                    </ul>
                  </div>
                </div>
              </article>

              <div class="mini-actions">
                <button
                  type="button"
                  class="mini-button"
                  :disabled="!selectedVariantMarkdown"
                  @click="copyContent(selectedVariantMarkdown)"
                >
                  复制当前版本
                </button>
                <button
                  type="button"
                  class="mini-button"
                  :disabled="!selectedVariantMarkdown"
                  @click="exportContent(selectedVariantMarkdown, selectedVariantFileName)"
                >
                  导出 Markdown
                </button>
              </div>
            </template>
          </div>
        </article>
      </div>

      <div class="composer">
        <label class="composer-field">
          <span>告诉 UP AI 你的需求...</span>
          <textarea
            ref="chatComposerRef"
            v-model="chatInput"
            rows="4"
            placeholder="告诉 UP AI 你的需求..."
            @keydown="onComposerKeydown"
          />
        </label>

        <div class="composer-footer">
          <div class="quick-tags">
            <button
              v-for="tag in quickTags"
              :key="tag"
              type="button"
              class="quick-button"
              @click="applyQuickPrompt(tag)"
            >
              {{ tag }}
            </button>
          </div>

          <button
            class="send-button"
            type="button"
            :disabled="sendingMessage || generating || !chatInput.trim()"
            @click="sendChatMessage"
          >
            ↑
          </button>
        </div>
      </div>
    </section>
  </section>
</template>

<style scoped>
.resume-page {
  display: grid;
  gap: 20px;
  max-width: none;
}

.page-header {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: flex-start;
  padding: 4px 2px 0;
}

.eyebrow,
.section-kicker,
.form-message-kicker,
.variant-kicker,
.variant-label,
.form-summary-label {
  margin: 0;
  color: #6b7386;
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.18em;
  text-transform: uppercase;
}

.page-header h2,
.section-head h3,
.form-message-head h4,
.variant-head h4 {
  margin: 8px 0 0;
  color: #1f2a44;
  line-height: 1.2;
}

.page-header h2 {
  font-size: 30px;
}

.section-head h3,
.form-message-head h4,
.variant-head h4 {
  font-size: 22px;
}

.page-note,
.form-message-note {
  margin: 10px 0 0;
  color: #667085;
  font-size: 14px;
  line-height: 1.8;
}

.header-pills {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.status-pill,
.section-tag {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 34px;
  padding: 0 14px;
  border-radius: 999px;
  border: 1px solid #dce4ff;
  background: #edf2ff;
  color: #355bff;
  font-size: 12px;
  font-weight: 700;
}

.status-pill.soft {
  border-color: #edf0f6;
  background: #f6f8fc;
  color: #667085;
}

.banner {
  margin: 0;
  padding: 14px 16px;
  border-radius: 16px;
  font-size: 14px;
  line-height: 1.7;
}

.error-banner {
  border: 1px solid #ffd4d4;
  background: #fff5f5;
  color: #c24141;
}

.status-banner {
  border: 1px solid #dbe9ff;
  background: #f4f8ff;
  color: #355bff;
}

.panel {
  padding: 22px;
  border: 1px solid rgba(225, 231, 242, 0.92);
  border-radius: 24px;
  background: rgba(255, 255, 255, 0.94);
  backdrop-filter: blur(14px);
  box-shadow: 0 24px 60px rgba(31, 43, 77, 0.08);
}

.chat-panel {
  display: grid;
  gap: 18px;
  min-height: 840px;
}

.section-head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: flex-start;
}

.chat-window {
  display: grid;
  gap: 18px;
  align-content: start;
}

.chat-message {
  display: grid;
  gap: 10px;
}

.chat-message.user {
  justify-items: end;
}

.chat-message.assistant,
.chat-message.system {
  justify-items: start;
}

.bubble {
  width: min(920px, 100%);
  padding: 18px 20px;
  border-radius: 22px;
  box-shadow: 0 16px 34px rgba(31, 43, 77, 0.08);
}

.chat-message.user .bubble {
  background: linear-gradient(135deg, #355bff 0%, #5d7aff 100%);
  color: #ffffff;
}

.chat-message.assistant .bubble {
  background: #ffffff;
  border: 1px solid #edf0f6;
}

.chat-message.system .bubble {
  border: 1px solid #e5ecff;
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.96), rgba(247, 250, 255, 0.98));
}

.form-bubble,
.variant-bubble {
  display: grid;
  gap: 16px;
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

.field {
  display: grid;
  gap: 9px;
  color: #1f2a44;
  font-size: 13px;
  font-weight: 700;
}

.field.full-width {
  grid-column: 1 / -1;
}

.field input,
.field textarea,
.field select,
.composer-field textarea {
  width: 100%;
  border: 1px solid #dfe5f1;
  border-radius: 16px;
  background: #ffffff;
  color: #1f2a44;
  font: inherit;
  transition:
    border-color 0.2s ease,
    box-shadow 0.2s ease;
}

.field input,
.field select {
  min-height: 48px;
  padding: 0 14px;
}

.field textarea,
.composer-field textarea {
  padding: 14px;
  resize: vertical;
}

.field input:focus,
.field textarea:focus,
.field select:focus,
.composer-field textarea:focus {
  outline: none;
  border-color: #c7d4ff;
  box-shadow: 0 0 0 4px rgba(53, 91, 255, 0.08);
}

.form-summary {
  display: grid;
  gap: 10px;
}

.summary-chips,
.tag-list,
.quick-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.summary-chip,
.tag {
  display: inline-flex;
  align-items: center;
  min-height: 34px;
  padding: 0 12px;
  border-radius: 999px;
  background: #eef2ff;
  color: #355bff;
  font-size: 12px;
  font-weight: 700;
}

.action-row,
.mini-actions,
.message-actions,
.variant-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.primary-button,
.secondary-button,
.ghost-button,
.mini-button,
.chip-button,
.quick-button,
.variant-tab,
.send-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid transparent;
  border-radius: 14px;
  font: inherit;
  cursor: pointer;
  transition:
    transform 0.2s ease,
    background 0.2s ease,
    border-color 0.2s ease,
    color 0.2s ease,
    opacity 0.2s ease;
}

.primary-button {
  min-height: 46px;
  padding: 0 16px;
  background: linear-gradient(135deg, #355bff 0%, #4f72ff 100%);
  color: #ffffff;
  font-size: 14px;
  font-weight: 800;
  box-shadow: 0 14px 28px rgba(53, 91, 255, 0.2);
}

.secondary-button,
.ghost-button,
.mini-button,
.chip-button,
.quick-button,
.variant-tab {
  min-height: 44px;
  padding: 0 14px;
  border-color: #e4e8f2;
  background: #ffffff;
  color: #5f6880;
}

.ghost-button {
  background: #f8faff;
}

.primary-button:hover,
.secondary-button:hover,
.ghost-button:hover,
.mini-button:hover,
.chip-button:hover,
.quick-button:hover,
.variant-tab:hover,
.send-button:hover {
  transform: translateY(-1px);
}

.primary-button:disabled,
.secondary-button:disabled,
.ghost-button:disabled,
.send-button:disabled {
  opacity: 0.55;
  cursor: not-allowed;
  transform: none;
}

.progress-box {
  display: grid;
  gap: 12px;
  padding: 16px;
  border-radius: 18px;
  background: #f8faff;
  border: 1px solid #ebeff8;
}

.progress-head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  color: #334155;
  font-size: 13px;
  font-weight: 700;
}

.progress-track {
  height: 10px;
  overflow: hidden;
  border-radius: 999px;
  background: #e9edf7;
}

.progress-bar {
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(135deg, #355bff 0%, #28b7ca 100%);
  transition: width 0.2s ease;
}

.progress-preview {
  margin: 0;
  color: #64748b;
  font-size: 13px;
  line-height: 1.7;
  white-space: pre-wrap;
}

.plain-message {
  margin: 0;
  white-space: pre-wrap;
  line-height: 1.8;
}

.variant-head,
.variant-summary,
.variant-grid,
.variant-block {
  display: grid;
  gap: 12px;
}

.variant-tab.active {
  border-color: #355bff;
  background: #355bff;
  color: #ffffff;
}

.variant-summary-text {
  margin: 0;
  color: #334155;
  font-size: 14px;
  line-height: 1.8;
}

.entry-list {
  display: grid;
  gap: 12px;
}

.entry-card {
  display: grid;
  gap: 8px;
  padding: 14px;
  border-radius: 16px;
  border: 1px solid #edf0f6;
  background: #fbfcff;
}

.entry-card strong {
  color: #1f2a44;
  font-size: 14px;
}

.entry-card ul {
  margin: 0;
  padding-left: 18px;
  color: #5f6880;
  font-size: 13px;
  line-height: 1.8;
}

.markdown-body :deep(h1),
.markdown-body :deep(h2),
.markdown-body :deep(h3) {
  color: #1f2a44;
}

.markdown-body :deep(h1) {
  margin-top: 0;
  font-size: 24px;
}

.markdown-body :deep(h2) {
  margin-top: 18px;
  font-size: 18px;
}

.markdown-body :deep(h3) {
  margin-top: 14px;
  font-size: 15px;
}

.markdown-body :deep(p),
.markdown-body :deep(li) {
  color: #455164;
  line-height: 1.8;
}

.markdown-body :deep(ul) {
  padding-left: 20px;
}

.composer {
  display: grid;
  gap: 14px;
  padding-top: 18px;
  border-top: 1px solid #eef2fb;
}

.composer-field {
  display: grid;
  gap: 8px;
  color: #1f2a44;
  font-size: 13px;
  font-weight: 700;
}

.composer-field textarea {
  min-height: 126px;
}

.composer-footer {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px;
}

.quick-button {
  min-height: 38px;
  padding: 0 12px;
  font-size: 12px;
}

.send-button {
  width: 52px;
  height: 52px;
  flex: 0 0 auto;
  border-radius: 16px;
  background: linear-gradient(135deg, #355bff 0%, #4f72ff 100%);
  color: #ffffff;
  font-size: 28px;
  font-weight: 700;
  box-shadow: 0 14px 28px rgba(53, 91, 255, 0.2);
}

@media (max-width: 1100px) {
  .page-header {
    flex-direction: column;
  }

  .form-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 900px) {
  .composer-footer {
    flex-direction: column;
    align-items: stretch;
  }

  .send-button {
    width: 100%;
  }
}

@media (max-width: 640px) {
  .panel {
    padding: 16px;
  }

  .page-header h2 {
    font-size: 24px;
  }

  .section-head h3,
  .form-message-head h4,
  .variant-head h4 {
    font-size: 20px;
  }
}
</style>
