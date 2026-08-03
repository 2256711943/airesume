import { expect, test, type Page, type Route } from '@playwright/test';
import { TOKEN_KEY } from '../utils/auth';

interface ConversationPost {
  title?: string;
}

interface MessagePost {
  role?: string;
  content?: string;
  intent?: string | null;
  agentName?: string | null;
}

interface ChatPost {
  conversationId?: string;
  message?: string;
  title?: string;
  historyLimit?: number;
}

interface ConversationMockOptions {
  conversationId: string;
  assistantMessage: string;
  createdTitles: string[];
  persistedMessages: MessagePost[];
}

const AUTH_TOKEN = 'token-abc';

const fulfillJson = async (route: Route, status: number, body: unknown) => {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
};

const fulfillSse = async (
  route: Route,
  events: Array<{ event: string; data: Record<string, unknown> }>,
) => {
  const body = `${events
    .map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}`)
    .join('\n\n')}\n\n`;

  await route.fulfill({
    status: 200,
    contentType: 'text/event-stream',
    headers: {
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    },
    body,
  });
};

const setupAuthenticatedSession = async (page: Page) => {
  await page.addInitScript((tokenKey) => {
    if (sessionStorage.getItem('__auth_reset_done__') === '1') {
      return;
    }

    localStorage.removeItem(tokenKey);
    sessionStorage.setItem('__auth_reset_done__', '1');
  }, TOKEN_KEY);

  await page.route('**/auth/login', async (route) => {
    await fulfillJson(route, 200, {
      data: {
        accessToken: AUTH_TOKEN,
        expiresIn: 7200,
      },
    });
  });

  await page.route('**/auth/me', async (route) => {
    const authHeader = route.request().headers().authorization;

    if (authHeader !== `Bearer ${AUTH_TOKEN}`) {
      await fulfillJson(route, 401, {
        success: false,
        data: null,
        error: { code: 'UNAUTHORIZED', message: 'Unauthorized' },
        requestId: 'req-auth-401',
      });
      return;
    }

    await fulfillJson(route, 200, {
      data: {
        id: 'user-1',
        email: 'user@example.com',
        name: 'Demo User',
      },
    });
  });
};

const setupConversationMocks = async (page: Page, options: ConversationMockOptions) => {
  await page.route('**/conversations', async (route) => {
    const payload = route.request().postDataJSON() as ConversationPost;
    options.createdTitles.push(payload.title ?? '');

    await fulfillJson(route, 200, {
      success: true,
      data: {
        id: options.conversationId,
        title: payload.title ?? 'Resume Session',
        status: 'active',
        createdAt: '2026-06-06T00:00:00.000Z',
        updatedAt: '2026-06-06T00:00:00.000Z',
      },
      error: null,
      requestId: 'req-conversation-1',
    });
  });

  await page.route('**/conversations/**/messages', async (route) => {
    const payload = route.request().postDataJSON() as MessagePost;
    options.persistedMessages.push(payload);

    await fulfillJson(route, 200, {
      success: true,
      data: {
        id: `msg-${options.persistedMessages.length}`,
        role: payload.role ?? 'user',
        content: payload.content ?? '',
        intent: payload.intent ?? null,
        agentName: payload.agentName ?? null,
        createdAt: '2026-06-06T00:00:00.000Z',
      },
      error: null,
      requestId: `req-message-${options.persistedMessages.length}`,
    });
  });

  await page.route('**/chat/message', async (route) => {
    const payload = route.request().postDataJSON() as ChatPost;

    await fulfillJson(route, 200, {
      success: true,
      data: {
        conversationId: payload.conversationId ?? options.conversationId,
        agentRunId: 'run-1',
        createdConversation: true,
        message: {
          id: 'msg-user-1',
          role: 'user',
          content: payload.message ?? '',
          intent: 'resume_diagnosis',
          agentName: 'resumeDiagnosisAgent',
          createdAt: '2026-06-06T00:00:00.000Z',
        },
        assistantMessage: {
          id: 'msg-assistant-1',
          role: 'assistant',
          content: options.assistantMessage,
          intent: 'resume_diagnosis',
          agentName: 'resumeDiagnosisAgent',
          createdAt: '2026-06-06T00:00:01.000Z',
        },
        routeDecision: {
          intent: 'resume_diagnosis',
          selectedAgent: 'resumeDiagnosisAgent',
          reason: 'resume keywords detected',
        },
        recentMessages: [],
      },
      error: null,
      requestId: 'req-chat-1',
    });
  });
};

const openResumePage = async (page: Page) => {
  await page.goto('/login');
  await page.locator('input[type="email"]').fill('user@example.com');
  await page.locator('input[type="password"]').fill('secret123');
  await page.locator('form.login-card button[type="submit"]').click();
  await expect(page).toHaveURL(/\/resume$/);
  await expect(page.locator('header.workspace-topbar h1')).toBeVisible();
  await expect(page.locator('.form-grid')).toBeVisible();
};

const fillResumeForm = async (page: Page) => {
  const textInputs = page.locator('.form-grid .field input');

  await expect(textInputs).toHaveCount(4);
  await textInputs.nth(0).fill('Alex Chen');
  await page.locator('.form-grid .field textarea').first().fill('Five years of backend experience in SaaS.');
  await textInputs.nth(1).fill('Backend Engineer');
  await textInputs.nth(2).fill('Node.js, NestJS, PostgreSQL');
};

test.describe('resume page flow', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuthenticatedSession(page);
  });

  test('clears an invalid persisted conversation id but keeps the local draft', async ({ page }) => {
    let restoreAttempts = 0;

    await page.addInitScript(() => {
      localStorage.setItem(
        'aitext_resume_session:user-1',
        JSON.stringify({
          conversationId: 'conv-stale-1',
          form: {
            fullName: 'Alex Chen',
            background: 'Five years of backend experience in SaaS.',
            targetRole: 'Backend Engineer',
            targetDescription: '',
            skillsText: 'Node.js, NestJS, PostgreSQL',
            targetSkillsText: '',
            experienceText: '',
            projectText: '',
            tone: 'professional',
            language: 'zh-CN',
          },
          resumeVariants: [
            {
              id: 'draft-1',
              mode: 'hybrid',
              summary: 'Recovered draft summary.',
              experience: [
                {
                  company: 'Acme',
                  role: 'Backend Engineer',
                  highlights: ['Improved service reliability'],
                },
              ],
              projects: [
                {
                  name: 'Resume Assistant',
                  highlights: ['Built session recovery'],
                },
              ],
              skills: ['Node.js', 'NestJS', 'PostgreSQL'],
            },
          ],
          selectedVariantIndex: 0,
          lastGenerateQuery: 'profile=alex',
        }),
      );
    });

    await page.route('**/conversations/conv-stale-1/resume-session**', async (route) => {
      restoreAttempts += 1;
      await fulfillJson(route, 404, {
        success: false,
        data: null,
        error: {
          code: 'CONVERSATION_NOT_FOUND',
          message: 'Conversation not found',
        },
        requestId: 'req-resume-restore-404',
      });
    });

    await openResumePage(page);

    await expect
      .poll(() => restoreAttempts)
      .toBe(1);
    await expect(page.locator('.error-banner')).toHaveCount(1);
    await expect(page.locator('.form-grid .field input').nth(0)).toHaveValue('Alex Chen');
    await expect(page.locator('.form-grid .field input').nth(1)).toHaveValue('Backend Engineer');
    await expect(page.locator('.variant-summary-text')).toContainText('Recovered draft summary.');

    await expect
      .poll(async () => {
        return page.evaluate(() => {
          const raw = localStorage.getItem('aitext_resume_session:user-1');
          return raw ? JSON.parse(raw).conversationId : null;
        });
      })
      .toBe('');

    await page.locator('.sidebar-item').nth(2).click();
    await expect(page).toHaveURL(/\/$/);

    await page.locator('.sidebar-item').first().click();

    await expect(page).toHaveURL(/\/resume$/);
    await expect(page.locator('.form-grid')).toBeVisible();
    await expect(page.locator('.error-banner')).toHaveCount(0);
    await expect(page.locator('.form-grid .field input').nth(0)).toHaveValue('Alex Chen');
    await expect(page.locator('.variant-summary-text')).toContainText('Recovered draft summary.');
    await expect
      .poll(() => restoreAttempts)
      .toBe(1);
  });

  test('generates three resume variants successfully', async ({ page }) => {
    const createdTitles: string[] = [];
    const persistedMessages: MessagePost[] = [];

    await setupConversationMocks(page, {
      conversationId: 'conv-generate-1',
      assistantMessage: 'Generated resume variants are ready.',
      createdTitles,
      persistedMessages,
    });

    await page.route('**/resume/generate/stream**', async (route) => {
      await fulfillSse(route, [
        { event: 'start', data: { taskId: 'task-1' } },
        { event: 'progress', data: { taskId: 'task-1', progress: 35, stage: 'planning' } },
        { event: 'chunk', data: { taskId: 'task-1', text: 'Drafting tailored resume bullets...' } },
        { event: 'progress', data: { taskId: 'task-1', progress: 100, stage: 'post_processing' } },
        {
          event: 'done',
          data: {
            taskId: 'task-1',
            variants: [
              {
                id: 'technical_v1',
                mode: 'technical',
                summary: 'Technical-first version for backend platform roles.',
                experience: [
                  {
                    company: 'Acme',
                    role: 'Backend Engineer',
                    highlights: ['Built APIs for a multi-tenant platform', 'Cut p95 latency by 40%'],
                  },
                ],
                projects: [
                  {
                    name: 'Resume Assistant',
                    highlights: ['Designed streaming resume generation'],
                  },
                ],
                skills: ['NestJS', 'Node.js', 'PostgreSQL'],
              },
              {
                id: 'business_v1',
                mode: 'business',
                summary: 'Outcome-focused version for business-facing stakeholders.',
                experience: [
                  {
                    company: 'Acme',
                    role: 'Backend Engineer',
                    highlights: ['Improved release predictability across teams'],
                  },
                ],
                projects: [
                  {
                    name: 'Resume Assistant',
                    highlights: ['Raised conversion from trial to consultation'],
                  },
                ],
                skills: ['Stakeholder communication', 'Node.js', 'Analytics'],
              },
              {
                id: 'hybrid_v1',
                mode: 'hybrid',
                summary: 'Balanced version for technical and cross-functional interviews.',
                experience: [
                  {
                    company: 'Acme',
                    role: 'Backend Engineer',
                    highlights: ['Balanced delivery speed with reliability goals'],
                  },
                ],
                projects: [
                  {
                    name: 'Resume Assistant',
                    highlights: ['Connected product goals with engineering output'],
                  },
                ],
                skills: ['NestJS', 'Product thinking', 'PostgreSQL'],
              },
            ],
          },
        },
      ]);
    });

    await openResumePage(page);
    await fillResumeForm(page);

    await page.locator('.action-row .primary-button').click();

    const variantTabs = page.locator('.variant-tabs .variant-tab');
    await expect(variantTabs).toHaveCount(3);
    await expect(page.locator('.variant-summary-text')).toContainText(
      'Technical-first version for backend platform roles.',
    );

    await variantTabs.nth(1).click();
    await expect(page.locator('.variant-summary-text')).toContainText(
      'Outcome-focused version for business-facing stakeholders.',
    );

    await variantTabs.nth(2).click();
    await expect(page.locator('.variant-summary-text')).toContainText(
      'Balanced version for technical and cross-functional interviews.',
    );

    await expect(page.locator('.variant-block .tag')).toHaveCount(3);
    await expect(page.locator('.entry-card').first()).toContainText('Acme');
    await expect(page.locator('.variant-summary-text')).toHaveText(/.+/);

    expect(createdTitles).toEqual(['Backend Engineer']);
    expect(persistedMessages.map((message) => message.role)).toEqual(['system', 'user', 'assistant']);
  });

  test('sends a chat message and creates a conversation', async ({ page }) => {
    const createdTitles: string[] = [];
    const persistedMessages: MessagePost[] = [];
    const userMessage = 'Please help me improve this resume.';
    const assistantMessage = 'Focus on measurable impact, ordering, and clearer project outcomes.';

    await setupConversationMocks(page, {
      conversationId: 'conv-chat-1',
      assistantMessage,
      createdTitles,
      persistedMessages,
    });

    await openResumePage(page);

    const chatRequestPromise = page.waitForRequest('**/chat/message');

    await page.locator('.composer-field textarea').fill(userMessage);
    await page.locator('.send-button').click();

    const chatRequest = await chatRequestPromise;
    const chatPayload = chatRequest.postDataJSON() as ChatPost;

    await expect(page.locator('.chat-message.user .plain-message').last()).toContainText(userMessage);
    await expect(page.locator('.chat-message.assistant .markdown-body').last()).toContainText(assistantMessage);

    expect(createdTitles).toHaveLength(1);
    expect(createdTitles[0]).toContain('UP AI');
    expect(persistedMessages).toHaveLength(1);
    expect(persistedMessages[0]?.role).toBe('system');
    expect(chatPayload).toMatchObject({
      conversationId: 'conv-chat-1',
      message: userMessage,
      historyLimit: 12,
    });
  });
});
