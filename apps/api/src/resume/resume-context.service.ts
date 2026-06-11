import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * 简历上下文摘要：当前对话关联的简历库条目压缩结构，供 Agent 生成时注入上下文。
 */
export interface ResumeContextSummary {
  id: string;
  title: string;
  summary: string;
  sourceMode: string;
  keySkills: string[];
  keyProjects: Array<{
    name: string;
    highlights: string[];
  }>;
  keyExperiences: Array<{
    company: string;
    role: string;
    highlights: string[];
  }>;
}

/**
 * 简历对话上下文：包含当前对话关联的简历库条目 ID、压缩摘要和选中数量。
 */
export interface ResumeConversationContext {
  activeResumeIds: string[];
  activeResumeSummaries: ResumeContextSummary[];
  selectedCount: number;
}

@Injectable()
export class ResumeContextService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 读取当前用户最近选中的简历库条目，并压缩成给 agent 使用的上下文。
   */
  async buildConversationContext(userId: string, conversationId: string): Promise<ResumeConversationContext> {
    const memorySlot = await this.prisma.conversationMemorySlot.findFirst({
      where: {
        conversationId,
        slotKey: 'selected_resume_item_ids',
        conversation: {
          userId,
        },
      },
      select: {
        slotValue: true,
      },
    });

    const activeResumeIds = this.extractResumeIds(memorySlot?.slotValue);
    if (activeResumeIds.length === 0) {
      return {
        activeResumeIds: [],
        activeResumeSummaries: [],
        selectedCount: 0,
      };
    }

    const items = await this.prisma.resumeLibraryItem.findMany({
      where: {
        userId,
        id: {
          in: activeResumeIds,
        },
      },
      orderBy: {
        updatedAt: 'desc',
      },
      select: {
        id: true,
        title: true,
        summary: true,
        sourceMode: true,
        skills: true,
        projects: true,
        experience: true,
      },
    });

    return {
      activeResumeIds,
      activeResumeSummaries: items.map((item) => this.toSummary(item)),
      selectedCount: items.length,
    };
  }

  /**
   * 从 memory slot 的值中提取简历 ID 列表，支持 JSON 数组或逗号分隔字符串。
   */
  private extractResumeIds(value: unknown): string[] {
    if (Array.isArray(value)) {
      return value.map((item) => String(item).trim()).filter(Boolean);
    }

    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) {
        return [];
      }

      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (Array.isArray(parsed)) {
          return parsed.map((item) => String(item).trim()).filter(Boolean);
        }
      } catch {
        return trimmed
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean);
      }
    }

    return [];
  }

  /**
   * 将简历库条目转换为上下文摘要结构，压缩 skills、projects、experience 字段。
   */
  private toSummary(item: {
    id: string;
    title: string;
    summary: string;
    sourceMode: string;
    skills: unknown;
    projects: unknown;
    experience: unknown;
  }): ResumeContextSummary {
    const keySkills = this.toStringArray(item.skills, 10);
    const keyProjects = this.toProjectSummaries(item.projects);
    const keyExperiences = this.toExperienceSummaries(item.experience);

    return {
      id: item.id,
      title: item.title,
      summary: item.summary,
      sourceMode: item.sourceMode,
      keySkills,
      keyProjects,
      keyExperiences,
    };
  }

  /**
   * 将 projects 字段转换为精简的项目摘要列表，最多保留 5 条。
   */
  private toProjectSummaries(value: unknown): Array<{ name: string; highlights: string[] }> {
    if (!Array.isArray(value)) {
      return [];
    }

    return value.slice(0, 5).map((item) => {
      const record = this.toRecord(item);
      return {
        name: this.toText(record.name) || '未命名项目',
        highlights: this.toStringArray(record.highlights, 5),
      };
    });
  }

  /**
   * 将 experience 字段转换为精简的工作经历摘要列表，最多保留 5 条。
   */
  private toExperienceSummaries(value: unknown): Array<{ company: string; role: string; highlights: string[] }> {
    if (!Array.isArray(value)) {
      return [];
    }

    return value.slice(0, 5).map((item) => {
      const record = this.toRecord(item);
      return {
        company: this.toText(record.company) || '未知公司',
        role: this.toText(record.role) || '未知职位',
        highlights: this.toStringArray(record.highlights, 5),
      };
    });
  }

  /**
   * 将任意值安全地转换为字符串数组，最多返回 limit 条。
   */
  private toStringArray(value: unknown, limit: number): string[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .map((item) => this.toText(item))
      .filter(Boolean)
      .slice(0, limit);
  }

  /**
   * 将任意值安全地转换为 Record 对象。
   */
  private toRecord(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {};
    }

    return value as Record<string, unknown>;
  }

  /**
   * 将任意值安全地转换为字符串，并去除首尾空格。
   */
  private toText(value: unknown): string {
    return String(value ?? '').trim();
  }
}
