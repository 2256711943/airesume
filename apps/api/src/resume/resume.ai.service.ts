import { Injectable } from '@nestjs/common';
import {
  type GenerateResumeDto,
  type ResumeExperienceDto,
  type ResumeProjectDto,
} from './dto/generate-resume.dto';

export interface AiResumeVariant {
  id: string;
  summary: string;
  experience: Array<{
    company: string;
    role: string;
    highlights: string[];
  }>;
  projects: Array<{
    name: string;
    highlights: string[];
  }>;
  skills: string[];
}

interface StreamOptions {
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
}

@Injectable()
export class ResumeAiService {
  async generate(input: GenerateResumeDto): Promise<AiResumeVariant[]> {
    const count = this.normalizeVariantCount(input.variants);
    const results: AiResumeVariant[] = [];

    for (let i = 0; i < count; i += 1) {
      const variantNo = i + 1;
      const style = i === 0 ? 'focused' : i === 1 ? 'impact' : 'leadership';
      results.push(this.buildVariant(input, variantNo, style));
    }

    return results;
  }

  async generateWithStream(
    input: GenerateResumeDto,
    options: StreamOptions = {},
  ): Promise<AiResumeVariant[]> {
    const variants = await this.generate(input);
    const markdown = this.renderMarkdownResume(
      variants[0],
      input.profile.fullName.trim(),
      input.targetJob.title.trim(),
    );
    const chunks = this.chunkText(markdown, 32);

    for (const chunk of chunks) {
      if (options.signal?.aborted) {
        break;
      }
      options.onDelta?.(chunk);
      await this.sleep(20);
    }

    return variants;
  }

  private renderMarkdownResume(
    variant: AiResumeVariant | undefined,
    fullName: string,
    targetRole: string,
  ): string {
    if (!variant) {
      return `# ${fullName || '候选人'} - ${targetRole || '目标岗位'}\n\n暂未生成可展示的简历内容。`;
    }

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

    const skillsSection = variant.skills.join(' / ');

    return [
      `# ${fullName || '候选人'} - ${targetRole || '目标岗位'}`,
      '',
      '## 个人简介',
      variant.summary,
      '',
      '## 工作经历',
      experienceSection || '- 暂无工作经历',
      '',
      '## 项目经历',
      projectSection || '- 暂无项目经历',
      '',
      '## 技能清单',
      skillsSection || '暂无技能信息',
    ].join('\n');
  }

  private buildVariant(
    input: GenerateResumeDto,
    variantNo: number,
    style: 'focused' | 'impact' | 'leadership',
  ): AiResumeVariant {
    const role = input.targetJob.title.trim();
    const name = input.profile.fullName.trim();
    const skills = this.mergeSkills(input.profile.skills, input.targetJob.mustHaveSkills);
    const summary = this.buildSummary(name, role, input.profile.background, style);

    return {
      id: `v${variantNo}`,
      summary,
      experience: this.normalizeExperience(input.profile.experiences, role, style),
      projects: this.normalizeProjects(input.profile.projects, role, style),
      skills,
    };
  }

  private buildSummary(
    fullName: string,
    role: string,
    background: string,
    style: 'focused' | 'impact' | 'leadership',
  ): string {
    if (style === 'impact') {
      return `${fullName} is a results-oriented candidate targeting ${role}. ${background} Focuses on measurable delivery, reliability, and execution quality.`;
    }

    if (style === 'leadership') {
      return `${fullName} is a collaborative ${role} candidate. ${background} Brings cross-team communication and ownership in ambiguous projects.`;
    }

    return `${fullName} is a ${role} candidate. ${background} Strong in system thinking, delivery speed, and practical problem solving.`;
  }

  private normalizeExperience(
    experiences: ResumeExperienceDto[],
    role: string,
    style: 'focused' | 'impact' | 'leadership',
  ): AiResumeVariant['experience'] {
    if (!Array.isArray(experiences) || experiences.length === 0) {
      return [
        {
          company: 'N/A',
          role,
          highlights: ['No structured experience provided. Add one or more experiences for stronger output.'],
        },
      ];
    }

    return experiences.map((item) => ({
      company: item.company,
      role: item.role,
      highlights: this.rewriteHighlights(item.highlights, style),
    }));
  }

  private normalizeProjects(
    projects: ResumeProjectDto[],
    role: string,
    style: 'focused' | 'impact' | 'leadership',
  ): AiResumeVariant['projects'] {
    if (!Array.isArray(projects) || projects.length === 0) {
      return [
        {
          name: `${role} Relevant Project`,
          highlights: ['No project details provided. Add project highlights to improve role matching.'],
        },
      ];
    }

    return projects.map((item) => ({
      name: item.name,
      highlights: this.rewriteHighlights(item.highlights, style),
    }));
  }

  private rewriteHighlights(
    highlights: string[],
    style: 'focused' | 'impact' | 'leadership',
  ): string[] {
    return highlights.map((text) => {
      const clean = text.trim();
      if (clean.length === 0) {
        return clean;
      }

      if (style === 'impact') {
        return `${clean} (emphasize measurable impact)`;
      }

      if (style === 'leadership') {
        return `${clean} (highlight collaboration and ownership)`;
      }

      return `${clean} (highlight role relevance)`;
    });
  }

  private mergeSkills(profileSkills: string[], jobSkills: string[]): string[] {
    const merged = [...profileSkills, ...jobSkills].map((item) => item.trim()).filter(Boolean);
    return Array.from(new Set(merged)).slice(0, 20);
  }

  private normalizeVariantCount(value: number): number {
    if (!value || value < 1) {
      return 1;
    }
    return Math.min(value, 3);
  }

  private chunkText(text: string, chunkSize: number): string[] {
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += chunkSize) {
      chunks.push(text.slice(i, i + chunkSize));
    }
    return chunks;
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
