<script setup lang="ts">
import MarkdownIt from 'markdown-it';
import { useAuth } from '../composables/useAuth';

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
  summary: string;
  experience: ResumeExperience[];
  projects: ResumeProject[];
  skills: string[];
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
  role: 'user' | 'assistant';
  content: string;
  streaming?: boolean;
}

type StreamEventName = 'start' | 'progress' | 'chunk' | 'done' | 'error' | 'canceled';

const API_BASE_URL = 'http://127.0.0.1:3001';
const { token, clearAuth } = useAuth();
const markdown = new MarkdownIt({
  breaks: true,
  linkify: true,
  html: false,
});

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
  variants: 1,
});

const generating = ref(false);
const chatMode = ref(false);
const errorMessage = ref('');
const generateMessage = ref('');
const requestId = ref('');
const taskId = ref('');
const streamProgress = ref(0);
const streamStage = ref('');
const streamPreview = ref('');
const variants = ref<ResumeVariant[]>([]);
const chatMessages = ref<ChatMessage[]>([]);
const currentAssistantMessageId = ref('');
const currentStreamController = ref<AbortController | null>(null);
const retryable = ref(false);
const lastQuery = ref<string>('');

const assistantActions = ['简历诊断', '简历翻译', '校招推荐', '面试指导', '职业规划'];

const stageLabelMap: Record<string, string> = {
  planning: '规划中',
  generating: '生成中',
  post_processing: '后处理中',
  idle: '等待中',
};

const streamStageLabel = computed(() => {
  if (!streamStage.value) {
    return '等待中';
  }

  return stageLabelMap[streamStage.value] ?? streamStage.value;
});

const splitByCommaOrLine = (value: string): string[] => {
  return value
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
};

const parseExperience = (value: string): ResumeExperience[] => {
  const lines = value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  return lines
    .map((line) => {
      const [company = '', role = '', highlightText = ''] = line.split('|').map((item) => item.trim());
      const highlights = highlightText
        .split(';')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);

      if (!company || !role) {
        return null;
      }

      return {
        company,
        role,
        highlights: highlights.length > 0 ? highlights : [`Worked as ${role}`],
      };
    })
    .filter((item): item is ResumeExperience => item !== null);
};

const parseProjects = (value: string): ResumeProject[] => {
  const lines = value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  return lines
    .map((line) => {
      const [name = '', highlightText = ''] = line.split('|').map((item) => item.trim());
      const highlights = highlightText
        .split(';')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);

      if (!name) {
        return null;
      }

      return {
        name,
        highlights: highlights.length > 0 ? highlights : ['Implemented core project milestones'],
      };
    })
    .filter((item): item is ResumeProject => item !== null);
};

const buildStreamQuery = (): string => {
  const profile = {
    fullName: form.fullName.trim(),
    background: form.background.trim(),
    skills: splitByCommaOrLine(form.skillsText),
    experiences: parseExperience(form.experienceText),
    projects: parseProjects(form.projectText),
  };

  const targetJob = {
    title: form.targetRole.trim(),
    description: form.targetDescription.trim(),
    mustHaveSkills: splitByCommaOrLine(form.targetSkillsText),
  };

  const params = new URLSearchParams({
    profile: JSON.stringify(profile),
    targetJob: JSON.stringify(targetJob),
    tone: form.tone.trim() || 'professional',
    language: form.language.trim() || 'zh-CN',
    variants: String(form.variants || 1),
  });

  return params.toString();
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
    summary: item.summary,
    experience: item.experience.map((exp) => ({
      company: String((exp as Record<string, unknown>).company ?? ''),
      role: String((exp as Record<string, unknown>).role ?? ''),
      highlights: Array.isArray((exp as Record<string, unknown>).highlights)
        ? ((exp as Record<string, unknown>).highlights as unknown[]).map((h) => String(h))
        : [],
    })),
    projects: item.projects.map((project) => ({
      name: String((project as Record<string, unknown>).name ?? ''),
      highlights: Array.isArray((project as Record<string, unknown>).highlights)
        ? ((project as Record<string, unknown>).highlights as unknown[]).map((h) => String(h))
        : [],
    })),
    skills: item.skills.map((skill) => String(skill)),
  }));
};

const renderMarkdown = (content: string) => markdown.render(content);

const buildUserPromptPreview = (): string => {
  return [
    `请根据以下信息生成 ${form.targetRole || '目标岗位'} 简历：`,
    `姓名：${form.fullName}`,
    `背景：${form.background}`,
    form.skillsText ? `技能：${form.skillsText}` : '',
    form.targetSkillsText ? `岗位要求：${form.targetSkillsText}` : '',
  ]
    .filter(Boolean)
    .join('\n');
};

const createAssistantMessage = () => {
  const messageId = `assistant_${Date.now()}`;
  currentAssistantMessageId.value = messageId;
  chatMessages.value.push({
    id: messageId,
    role: 'assistant',
    content: '',
    streaming: true,
  });
};

const appendAssistantChunk = (text: string) => {
  const message = chatMessages.value.find((item) => item.id === currentAssistantMessageId.value);
  if (!message) {
    return;
  }

  message.content += text;
};

const finishAssistantMessage = () => {
  const message = chatMessages.value.find((item) => item.id === currentAssistantMessageId.value);
  if (message) {
    message.streaming = false;
  }
};

const updateStreamContext = (payload: StreamStartPayload) => {
  if (typeof payload.requestId === 'string' && payload.requestId.length > 0) {
    requestId.value = payload.requestId;
  }

  if (typeof payload.taskId === 'string' && payload.taskId.length > 0) {
    taskId.value = payload.taskId;
  }
};

const handleStreamEvent = (eventName: string, payload: Record<string, unknown>) => {
  const event = eventName as StreamEventName;

  if (event === 'start') {
    updateStreamContext(payload as StreamStartPayload);
    streamProgress.value = 0;
    streamStage.value = 'planning';
    return;
  }

  if (event === 'progress') {
    const progressPayload = payload as StreamProgressPayload;
    updateStreamContext(progressPayload);
    streamProgress.value = Math.max(0, Math.min(100, Number(progressPayload.progress ?? 0)));
    streamStage.value = typeof progressPayload.stage === 'string' ? progressPayload.stage : streamStage.value;
    return;
  }

  if (event === 'chunk') {
    const chunkPayload = payload as StreamChunkPayload;
    updateStreamContext(chunkPayload);
    if (typeof chunkPayload.text === 'string') {
      streamPreview.value += chunkPayload.text;
      appendAssistantChunk(chunkPayload.text);
    }
    return;
  }

  if (event === 'done') {
    const donePayload = payload as StreamDonePayload;
    updateStreamContext(donePayload);
    streamProgress.value = 100;
    streamStage.value = 'post_processing';
    variants.value = parseVariants(donePayload.variants);
    generateMessage.value = '简历生成完成。';
    retryable.value = false;
    finishAssistantMessage();
    return;
  }

  if (event === 'error') {
    const errorPayload = payload as StreamErrorPayload;
    updateStreamContext(errorPayload);
    const code = typeof errorPayload.code === 'string' ? `[${errorPayload.code}] ` : '';
    const message =
      typeof errorPayload.message === 'string' ? errorPayload.message : '简历生成失败，请稍后重试。';
    errorMessage.value = `${code}${message}`;
    retryable.value = true;
    finishAssistantMessage();
    return;
  }

  updateStreamContext(payload as StreamStartPayload);
  generateMessage.value = '已取消生成。';
  retryable.value = true;
  finishAssistantMessage();
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

    const rawData = dataParts.join('\n');
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(rawData) as Record<string, unknown>;
    } catch {
      return;
    }

    handleStreamEvent(eventName, payload);
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
  generateMessage.value = '';
  requestId.value = '';
  taskId.value = '';
  streamProgress.value = 0;
  streamStage.value = '';
  streamPreview.value = '';
  variants.value = [];
  retryable.value = false;

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
      throw new Error(`流式接口返回异常：HTTP ${response.status}`);
    }

    if (!response.body) {
      throw new Error('流式接口未返回可读数据流。');
    }

    await consumeSseStream(response.body);
  } catch (error) {
    if (controller.signal.aborted) {
      generateMessage.value = '已取消生成。';
      retryable.value = true;
    } else {
      errorMessage.value = error instanceof Error ? error.message : '简历生成失败，请稍后重试。';
      retryable.value = true;
    }
    finishAssistantMessage();
  } finally {
    generating.value = false;
    currentStreamController.value = null;
  }
};

const generateResume = async () => {
  if (!form.fullName.trim() || !form.background.trim() || !form.targetRole.trim()) {
    errorMessage.value = '请至少填写姓名、背景简介和目标岗位。';
    return;
  }

  if (splitByCommaOrLine(form.skillsText).length === 0) {
    errorMessage.value = '请至少填写一项技能。';
    return;
  }

  chatMode.value = true;
  chatMessages.value = [
    {
      id: `user_${Date.now()}`,
      role: 'user',
      content: buildUserPromptPreview(),
    },
  ];
  createAssistantMessage();

  const query = buildStreamQuery();
  lastQuery.value = query;
  await startGenerateStream(query);
};

const retryGenerate = async () => {
  if (!lastQuery.value) {
    generateMessage.value = '暂无可重试请求。';
    return;
  }

  chatMode.value = true;
  chatMessages.value.push({
    id: `user_retry_${Date.now()}`,
    role: 'user',
    content: '请基于相同信息重新生成一版简历。',
  });
  createAssistantMessage();
  await startGenerateStream(lastQuery.value);
};

const cancelGenerate = () => {
  currentStreamController.value?.abort();
};

const backToForm = () => {
  chatMode.value = false;
};

const showAiAssistHint = () => {
  generateMessage.value = 'AI 帮写入口已预留，后续会接入字段级生成能力。';
};

const copyAssistantMessage = async (content: string) => {
  await navigator.clipboard.writeText(content);
  generateMessage.value = '已复制简历内容。';
};

const exportAssistantMessage = (content: string) => {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${form.fullName || 'resume'}.md`;
  link.click();
  URL.revokeObjectURL(url);
  generateMessage.value = '已导出 Markdown 简历。';
};

onBeforeUnmount(() => {
  currentStreamController.value?.abort();
});
</script>

<template>
  <section class="resume-page">
    <template v-if="!chatMode">
      <form class="editor-panel" @submit.prevent="generateResume">
        <div class="editor-header">
          <div>
            <p class="eyebrow">Resume Assistant</p>
            <h2>AI 简历生成</h2>
            <p>填写候选人基础信息、目标岗位与经历内容，生成结构化简历文本。</p>
          </div>
          <span class="state-pill">{{ generating ? '生成中' : '待生成' }}</span>
        </div>

        <div class="form-grid">
          <div class="form-field field-span">
            <label for="fullName">姓名 <span>*</span></label>
            <input id="fullName" v-model="form.fullName" type="text" maxlength="80" placeholder="例如：张三" required />
          </div>

          <div class="form-field">
            <label for="targetRole">目标岗位 <span>*</span></label>
            <input
              id="targetRole"
              v-model="form.targetRole"
              type="text"
              maxlength="100"
              placeholder="例如：后端开发工程师"
              required
            />
          </div>

          <div class="form-field">
            <label for="language">语言</label>
            <select id="language" v-model="form.language">
              <option value="zh-CN">zh-CN</option>
              <option value="en-US">en-US</option>
            </select>
          </div>

          <div class="form-field field-span">
            <label for="background">背景简介 <span>*</span></label>
            <textarea
              id="background"
              v-model="form.background"
              rows="3"
              placeholder="例如：2年后端开发经验，参与高并发服务治理与接口性能优化。"
              required
            />
          </div>

          <div class="form-field field-span">
            <label for="skillsText">技能清单</label>
            <input
              id="skillsText"
              v-model="form.skillsText"
              type="text"
              placeholder="Node.js, NestJS, PostgreSQL, Redis"
            />
          </div>

          <div class="form-field field-span">
            <label for="targetSkillsText">岗位技能要求</label>
            <input
              id="targetSkillsText"
              v-model="form.targetSkillsText"
              type="text"
              placeholder="微服务、性能优化、可观测性、消息队列"
            />
          </div>

          <div class="form-field field-span">
            <label for="targetDescription">岗位描述</label>
            <textarea
              id="targetDescription"
              v-model="form.targetDescription"
              rows="3"
              placeholder="补充岗位职责、业务场景或团队需求，帮助模型生成更贴合的内容。"
            />
          </div>

          <div class="form-field">
            <label for="tone">语气</label>
            <select id="tone" v-model="form.tone">
              <option value="professional">professional</option>
              <option value="concise">concise</option>
            </select>
          </div>

          <div class="form-field">
            <label for="variants">版本数</label>
            <input id="variants" v-model.number="form.variants" type="number" min="1" max="3" />
          </div>

          <div class="rich-editor field-span">
            <div class="rich-header">
              <label for="experienceText">工作经历</label>
              <button class="ai-button" type="button" @click="showAiAssistHint">
                <span>✦</span>
                <span>AI帮写</span>
              </button>
            </div>

            <div class="toolbar-row">
              <button type="button">↶</button>
              <button type="button">↷</button>
              <button type="button">B</button>
              <button type="button">I</button>
              <button type="button">≣</button>
              <button type="button">☰</button>
              <button type="button">⋯</button>
              <button type="button">🔗</button>
            </div>

            <textarea
              id="experienceText"
              v-model="form.experienceText"
              rows="8"
              placeholder="写作公式：【主修课程+成绩】→【获得奖项+排名】→【学生工作/科研/社团活动】&#10;点击右上角『AI帮写』，让 AI 帮你生成专业的描述。"
            />
            <p class="field-tip">格式：每行 `公司|岗位|亮点1;亮点2`</p>
          </div>

          <div class="form-field field-span">
            <div class="field-row">
              <label for="projectText">项目经历</label>
              <button class="ai-button" type="button" @click="showAiAssistHint">
                <span>✦</span>
                <span>AI帮写</span>
              </button>
            </div>
            <textarea
              id="projectText"
              v-model="form.projectText"
              rows="4"
              placeholder="每行格式：项目名|亮点1;亮点2"
            />
          </div>
        </div>

        <p v-if="errorMessage" class="error-text">{{ errorMessage }}</p>
        <p v-if="generateMessage" class="status-message">{{ generateMessage }}</p>

        <div class="submit-row">
          <div class="secondary-actions">
            <button class="secondary-button" type="button" :disabled="!generating" @click="cancelGenerate">
              取消
            </button>
            <button class="secondary-button" type="button" :disabled="generating || !retryable" @click="retryGenerate">
              重试
            </button>
          </div>

          <button class="submit-button" type="submit" :disabled="generating">
            <span class="submit-icon">▷</span>
            <span>{{ generating ? '生成中...' : '提交' }}</span>
          </button>
        </div>
      </form>
    </template>

    <template v-else>
      <section class="chat-shell">
        <header class="chat-header">
          <button class="back-button" type="button" @click="backToForm">← 返回编辑</button>
          <div>
            <h2>AI 简历对话</h2>
            <p>正在为你整理最终简历内容</p>
          </div>
        </header>

        <div class="chat-messages">
          <article
            v-for="message in chatMessages"
            :key="message.id"
            class="chat-message"
            :class="message.role"
          >
            <div class="message-bubble">
              <div
                v-if="message.role === 'assistant'"
                class="markdown-body"
                v-html="renderMarkdown(message.content || '正在生成简历内容...')"
              ></div>
              <p v-else class="plain-message">{{ message.content }}</p>
            </div>

            <div v-if="message.role === 'assistant' && !message.streaming" class="message-actions">
              <button type="button" class="chip-button" @click="retryGenerate">重新生成</button>
              <button type="button" class="chip-button" @click="copyAssistantMessage(message.content)">复制</button>
              <button type="button" class="chip-button" @click="exportAssistantMessage(message.content)">导出</button>
            </div>
          </article>
        </div>

        <p v-if="errorMessage" class="error-text">{{ errorMessage }}</p>
        <p v-if="generateMessage" class="status-message">{{ generateMessage }}</p>

        <footer class="assistant-dock">
          <div class="dock-input">
            <p>继续对话能力预留中，当前可先进行复制、重新生成和导出操作。</p>
          </div>
          <div class="dock-actions">
            <button v-for="item in assistantActions" :key="item" type="button">{{ item }}</button>
          </div>
        </footer>
      </section>
    </template>
  </section>
</template>

<style scoped>
.resume-page {
  display: grid;
  gap: 24px;
}

.editor-panel,
.chat-shell {
  width: 100%;
  max-width: 900px;
  margin: 0 auto;
  background: #ffffff;
  border-radius: 24px;
  box-shadow: 0 12px 34px rgba(21, 30, 55, 0.08);
}

.editor-panel {
  display: grid;
  gap: 24px;
  padding: 28px;
}

.chat-shell {
  display: grid;
  gap: 20px;
  padding: 24px;
}

.editor-header,
.rich-header,
.field-row,
.submit-row,
.secondary-actions,
.stream-header,
.dock-actions,
.chat-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.eyebrow {
  margin: 0 0 6px;
  color: #9aa2b3;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.18em;
  text-transform: uppercase;
}

.editor-header h2,
.chat-header h2 {
  margin: 0;
  color: #2f3747;
  font-size: 24px;
}

.editor-header p,
.field-tip,
.status-message,
.stream-meta,
.dock-input p,
.chat-header p {
  margin: 0;
  color: #98a1b2;
  font-size: 13px;
  line-height: 1.7;
}

.state-pill {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 34px;
  padding: 0 14px;
  border-radius: 12px;
  background: #eef1ff;
  color: #405fff;
  font-size: 12px;
  font-weight: 700;
}

.state-pill.soft {
  background: #f5f7fd;
  color: #667085;
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 18px 20px;
}

.form-field {
  display: grid;
  gap: 10px;
}

.field-span {
  grid-column: 1 / -1;
}

.form-field label,
.rich-editor label {
  color: #31394b;
  font-size: 14px;
  font-weight: 700;
}

.form-field label span {
  color: #ff5f5f;
}

.form-field input,
.form-field textarea,
.form-field select,
.rich-editor textarea {
  width: 100%;
  min-height: 48px;
  border: 1px solid #e7ebf3;
  border-radius: 14px;
  background: #ffffff;
  color: #2f3747;
  font: inherit;
  transition: all 0.2s ease;
}

.form-field input,
.form-field select {
  padding: 0 16px;
}

.form-field textarea,
.rich-editor textarea {
  padding: 14px 16px;
  resize: vertical;
}

.form-field input::placeholder,
.form-field textarea::placeholder,
.rich-editor textarea::placeholder {
  color: #c0c6d4;
}

.form-field input:focus,
.form-field textarea:focus,
.form-field select:focus,
.rich-editor textarea:focus {
  outline: none;
  border-color: #cfd7ff;
  box-shadow: 0 0 0 3px rgba(59, 92, 255, 0.08);
}

.rich-editor {
  display: grid;
  gap: 0;
  border: 1px solid #edf0f6;
  border-radius: 18px;
  overflow: hidden;
}

.rich-header,
.field-row {
  padding: 14px 16px 12px;
}

.toolbar-row {
  display: flex;
  gap: 10px;
  padding: 12px 16px;
  border-top: 1px solid #f0f2f8;
  border-bottom: 1px solid #f0f2f8;
}

.toolbar-row button {
  border: 0;
  background: transparent;
  color: #5f6880;
  font: inherit;
  cursor: pointer;
}

.rich-editor textarea {
  min-height: 190px;
  border: 0;
  border-radius: 0;
}

.rich-editor .field-tip {
  padding: 0 16px 14px;
}

.ai-button,
.secondary-button,
.submit-button,
.back-button,
.chip-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  font: inherit;
  cursor: pointer;
  transition: all 0.2s ease;
}

.ai-button {
  min-height: 38px;
  padding: 0 14px;
  border: 1px solid #eadfff;
  border-radius: 12px;
  background: linear-gradient(135deg, #f1e5ff 0%, #faefff 100%);
  color: #7a43ea;
  font-size: 12px;
  font-weight: 700;
}

.secondary-button,
.back-button,
.chip-button {
  min-height: 42px;
  padding: 0 16px;
  border: 1px solid #e8ebf2;
  border-radius: 12px;
  background: #ffffff;
  color: #5f6880;
}

.submit-button {
  min-width: 240px;
  min-height: 58px;
  padding: 0 20px;
  border: 0;
  border-radius: 16px;
  background: linear-gradient(135deg, #3a58f5 0%, #3f63ff 100%);
  color: #ffffff;
  font-size: 16px;
  font-weight: 700;
  box-shadow: 0 12px 24px rgba(58, 88, 245, 0.28);
}

.submit-icon {
  font-size: 15px;
}

.ai-button:hover,
.secondary-button:hover,
.submit-button:hover,
.back-button:hover,
.chip-button:hover {
  transform: translateY(-1px);
}

.ai-button:disabled,
.secondary-button:disabled,
.submit-button:disabled {
  opacity: 0.7;
  cursor: not-allowed;
  transform: none;
}

.chat-messages {
  display: grid;
  gap: 18px;
}

.chat-message {
  display: grid;
  gap: 10px;
}

.chat-message.user {
  justify-items: end;
}

.chat-message.assistant {
  justify-items: start;
}

.message-bubble {
  max-width: min(760px, 100%);
  padding: 18px 20px;
  border-radius: 20px;
  box-shadow: 0 10px 28px rgba(21, 30, 55, 0.08);
}

.chat-message.user .message-bubble {
  background: linear-gradient(135deg, #3a58f5 0%, #6b7cff 100%);
  color: #ffffff;
}

.chat-message.assistant .message-bubble {
  background: #ffffff;
  border: 1px solid #edf0f6;
}

.plain-message {
  margin: 0;
  white-space: pre-wrap;
  line-height: 1.8;
}

.message-actions {
  display: flex;
  gap: 10px;
}

.markdown-body :deep(h1),
.markdown-body :deep(h2),
.markdown-body :deep(h3) {
  color: #2f3747;
}

.markdown-body :deep(h1) {
  font-size: 28px;
  margin-top: 0;
}

.markdown-body :deep(h2) {
  font-size: 20px;
  margin-top: 20px;
}

.markdown-body :deep(h3) {
  font-size: 16px;
  margin-top: 16px;
}

.markdown-body :deep(p),
.markdown-body :deep(li) {
  color: #4b5567;
  line-height: 1.8;
}

.markdown-body :deep(ul) {
  padding-left: 20px;
}

.stream-box {
  display: grid;
  gap: 12px;
  padding: 18px;
  border-radius: 18px;
  background: #fafbff;
  border: 1px solid #eef1f8;
}

.stream-title {
  margin: 0;
  color: #2f3747;
  font-size: 14px;
  font-weight: 700;
}

.progress-track {
  height: 10px;
  overflow: hidden;
  border-radius: 999px;
  background: #eef1f8;
}

.progress-bar {
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(135deg, #3a58f5 0%, #7b5cff 100%);
  transition: width 0.2s ease;
}

.error-text {
  margin: 0;
  color: #dc2626;
  font-size: 14px;
}

.assistant-dock {
  display: grid;
  gap: 16px;
  padding: 18px 0 0;
  border-top: 1px solid #eef1f8;
}

.dock-input {
  min-height: 48px;
  display: flex;
  align-items: flex-start;
}

.dock-actions {
  justify-content: flex-start;
  flex-wrap: wrap;
}

.dock-actions button {
  border: 0;
  background: transparent;
  color: #98a1b2;
  cursor: pointer;
}

@media (max-width: 900px) {
  .form-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 640px) {
  .editor-panel,
  .chat-shell {
    padding: 14px;
  }

  .editor-header,
  .rich-header,
  .field-row,
  .stream-header,
  .submit-row,
  .secondary-actions,
  .chat-header,
  .message-actions {
    align-items: flex-start;
    flex-direction: column;
  }

  .ai-button,
  .secondary-button,
  .submit-button,
  .back-button,
  .chip-button {
    width: 100%;
  }
}
</style>
