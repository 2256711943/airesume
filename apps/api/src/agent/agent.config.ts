import { Injectable } from '@nestjs/common';
import type { SpecialistAgentName } from './orchestrator/orchestrator.service';

/** 单个 Agent 的可注册配置：系统提示词与暴露给模型使用的工具集。 */
export interface AgentConfig {
  id: SpecialistAgentName;
  systemPrompt: string;
  /** 该 Agent 向模型暴露的工具名（需已在 ToolRegistry 注册定义与执行函数）。 */
  toolNames: string[];
}

const RESUME_DIAGNOSIS_SYSTEM_PROMPT = `你是一个简历诊断助手，帮助用户分析岗位描述（JD）与简历的匹配度，并给出优化建议。
职责：
- 解析用户提供的岗位描述，提炼硬性要求、技能要求与潜在风险点；
- 结合用户简历上下文给出针对性修改建议；
- 当需要最新行业信息或岗位相关外部事实时，可以使用 web_search / web_browser 工具获取佐证。
注意：当前联网工具为 Mock 实现，搜索结果不可作为真实依据，引用时需说明来源不确定。`;

const INTERVIEW_COACH_SYSTEM_PROMPT = `你是一个面试指导助手，帮助用户准备面试问答、梳理表达框架并模拟追问。
职责：
- 判断提问类型（自我介绍、行为题、技术题、职业决策题等），给出结构化回答策略；
- 结合用户简历上下文，把回答落到具体经历与成果；
- 当需要最新面试动态或行业技术信息时，可以使用 web_search / web_browser 工具获取参考。
注意：当前联网工具为 Mock 实现，搜索结果不可作为真实依据。`;

const CAREER_PLANNER_SYSTEM_PROMPT = `你是一个职业规划助手，帮助用户梳理转型方向、能力缺口与分阶段行动计划。
职责：
- 判断用户的职业阶段（入行、成长、转型、晋升等），给出可执行的规划；
- 结合用户简历上下文，识别当前能力与目标岗位的差距；
- 当需要了解目标岗位的市场要求、行业趋势时，可以使用 web_search / web_browser 工具获取参考。
注意：当前联网工具为 Mock 实现，搜索结果不可作为真实依据。`;

/**
 * 默认三个 Specialist Agent 的配置。
 * 工具名由配置注入（不反向依赖 chat 模块的常量），需与 ToolRegistry 中注册的工具一致。
 */
export const DEFAULT_AGENT_CONFIGS: AgentConfig[] = [
  {
    id: 'resumeDiagnosisAgent',
    systemPrompt: RESUME_DIAGNOSIS_SYSTEM_PROMPT,
    toolNames: ['web_search', 'web_browser'],
  },
  {
    id: 'interviewCoachAgent',
    systemPrompt: INTERVIEW_COACH_SYSTEM_PROMPT,
    toolNames: ['web_search', 'web_browser'],
  },
  {
    id: 'careerPlannerAgent',
    systemPrompt: CAREER_PLANNER_SYSTEM_PROMPT,
    toolNames: ['web_search', 'web_browser'],
  },
];

/**
 * Agent 配置注册表：以 `AgentConfig` 替换 `AgentExecutorService` 的 switch 分发。
 * 业务侧按 `selectedAgent` 查表取配置（systemPrompt / toolNames）。
 */
@Injectable()
export class AgentConfigRegistry {
  private readonly configs = new Map<string, AgentConfig>();

  register(config: AgentConfig): void {
    if (this.configs.has(config.id)) {
      throw new Error(`agent_already_registered: ${config.id}`);
    }
    this.configs.set(config.id, config);
  }

  get(id: string): AgentConfig | undefined {
    return this.configs.get(id);
  }

  list(): AgentConfig[] {
    return [...this.configs.values()];
  }
}

/** 注册默认三个 Agent 配置，由 `AgentModule` 初始化时调用一次。 */
export function registerDefaultAgents(registry: AgentConfigRegistry): void {
  for (const config of DEFAULT_AGENT_CONFIGS) {
    registry.register(config);
  }
}
