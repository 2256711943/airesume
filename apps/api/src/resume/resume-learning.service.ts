import { Injectable } from '@nestjs/common';
import type { ResumeRewriteMode } from './resume.ai.service';
import { PrismaService } from '../prisma/prisma.service';

const RESUME_MODES: ResumeRewriteMode[] = ['technical', 'business', 'hybrid'];
const DEFAULT_PROMPT_VERSIONS: Record<ResumeRewriteMode, string[]> = {
  technical: ['resume-rewrite-technical-v1', 'resume-rewrite-technical-v2'],
  business: ['resume-rewrite-business-v1', 'resume-rewrite-business-v2'],
  hybrid: ['resume-rewrite-hybrid-v1', 'resume-rewrite-hybrid-v2'],
};

interface ModeAggregate {
  weightedSelections: number;
  totalSelections: number;
}

interface PromptVersionAggregate {
  weightedSelections: number;
}

export interface ResumeModeLearningPolicy {
  mode: ResumeRewriteMode;
  promptVersion: string;
  feedbackBoost: number;
  sampleSize: number;
}

export interface ResumeGenerationPolicy {
  modePolicies: Record<ResumeRewriteMode, ResumeModeLearningPolicy>;
}

@Injectable()
export class ResumeLearningService {
  constructor(private readonly prisma: PrismaService) {}

  async buildGenerationPolicy(userId: string, requestId: string): Promise<ResumeGenerationPolicy> {
    const [userEvents, globalEvents] = await Promise.all([
      this.prisma.resumeVariantSelectionEvent.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 40,
        select: {
          mode: true,
          addToLibrary: true,
          promptVersion: true,
        },
      }),
      this.prisma.resumeVariantSelectionEvent.findMany({
        orderBy: { createdAt: 'desc' },
        take: 240,
        select: {
          mode: true,
          addToLibrary: true,
          promptVersion: true,
        },
      }),
    ]);

    const userModeStats = this.aggregateModes(userEvents, 1);
    const globalModeStats = this.aggregateModes(globalEvents, 0.35);
    const userPromptStats = this.aggregatePromptVersions(userEvents, 1);
    const globalPromptStats = this.aggregatePromptVersions(globalEvents, 0.35);

    const modePolicies = RESUME_MODES.reduce(
      (accumulator, mode) => {
        const sampleSize =
          (userModeStats.get(mode)?.totalSelections ?? 0) +
          Math.round((globalModeStats.get(mode)?.totalSelections ?? 0) / 0.35);
        accumulator[mode] = {
          mode,
          promptVersion: this.selectPromptVersion(
            mode,
            requestId,
            userId,
            userPromptStats.get(mode),
            globalPromptStats.get(mode),
          ),
          feedbackBoost: this.computeFeedbackBoost(mode, userModeStats, globalModeStats),
          sampleSize,
        };
        return accumulator;
      },
      {} as Record<ResumeRewriteMode, ResumeModeLearningPolicy>,
    );

    return { modePolicies };
  }

  private aggregateModes(
    events: Array<{ mode: ResumeRewriteMode; addToLibrary: boolean }>,
    multiplier: number,
  ): Map<ResumeRewriteMode, ModeAggregate> {
    const aggregates = new Map<ResumeRewriteMode, ModeAggregate>();

    for (const mode of RESUME_MODES) {
      aggregates.set(mode, { weightedSelections: 0, totalSelections: 0 });
    }

    for (const event of events) {
      const current = aggregates.get(event.mode);
      if (!current) {
        continue;
      }

      const weight = multiplier + (event.addToLibrary ? 0.45 * multiplier : 0);
      current.weightedSelections += weight;
      current.totalSelections += 1;
    }

    return aggregates;
  }

  private aggregatePromptVersions(
    events: Array<{ mode: ResumeRewriteMode; addToLibrary: boolean; promptVersion: string }>,
    multiplier: number,
  ): Map<ResumeRewriteMode, Map<string, PromptVersionAggregate>> {
    const aggregates = new Map<ResumeRewriteMode, Map<string, PromptVersionAggregate>>();

    for (const mode of RESUME_MODES) {
      aggregates.set(mode, new Map());
    }

    for (const event of events) {
      const perMode = aggregates.get(event.mode);
      if (!perMode) {
        continue;
      }

      const current = perMode.get(event.promptVersion) ?? { weightedSelections: 0 };
      current.weightedSelections += multiplier + (event.addToLibrary ? 0.45 * multiplier : 0);
      perMode.set(event.promptVersion, current);
    }

    return aggregates;
  }

  private computeFeedbackBoost(
    mode: ResumeRewriteMode,
    userModeStats: Map<ResumeRewriteMode, ModeAggregate>,
    globalModeStats: Map<ResumeRewriteMode, ModeAggregate>,
  ): number {
    const baseline = 1 / RESUME_MODES.length;
    const userTotal = RESUME_MODES.reduce(
      (sum, key) => sum + (userModeStats.get(key)?.weightedSelections ?? 0),
      0,
    );
    const globalTotal = RESUME_MODES.reduce(
      (sum, key) => sum + (globalModeStats.get(key)?.weightedSelections ?? 0),
      0,
    );
    const userWeighted = userModeStats.get(mode)?.weightedSelections ?? 0;
    const globalWeighted = globalModeStats.get(mode)?.weightedSelections ?? 0;
    const userShare = userTotal > 0 ? userWeighted / userTotal : baseline;
    const globalShare = globalTotal > 0 ? globalWeighted / globalTotal : baseline;
    const blendedShare = userShare * 0.7 + globalShare * 0.3;
    const boost = (blendedShare - baseline) * 18;

    return Number(Math.max(-6, Math.min(6, boost)).toFixed(1));
  }

  private selectPromptVersion(
    mode: ResumeRewriteMode,
    requestId: string,
    userId: string,
    userStats?: Map<string, PromptVersionAggregate>,
    globalStats?: Map<string, PromptVersionAggregate>,
  ): string {
    const candidates = DEFAULT_PROMPT_VERSIONS[mode];
    const blended = candidates.map((version) => ({
      version,
      score:
        (userStats?.get(version)?.weightedSelections ?? 0) +
        (globalStats?.get(version)?.weightedSelections ?? 0) +
        1,
    }));
    const totalScore = blended.reduce((sum, item) => sum + item.score, 0);

    if (totalScore < 8) {
      const experimentalIndex = this.hashToIndex(`${userId}:${requestId}:${mode}`, candidates.length);
      return candidates[experimentalIndex];
    }

    return blended.sort((left, right) => right.score - left.score)[0]?.version ?? candidates[0];
  }

  private hashToIndex(value: string, modulo: number): number {
    let hash = 0;
    for (let i = 0; i < value.length; i += 1) {
      hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
    }
    return modulo > 0 ? hash % modulo : 0;
  }
}
