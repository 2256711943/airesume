import { Injectable } from '@nestjs/common';
import {
  MEMORY_DECISION_THRESHOLDS,
  type MemoryCandidate,
  type MemoryDecision,
} from './memory-candidate.types';

/**
 * 记忆决策器：根据候选的 5 维评分与语义类型，将其分流到
 * Constraint / Persistent / Candidate / Discard 四类落点。
 *
 * 判定顺序（自上而下，命中即返回）：
 * 1. Persistent —— 满足全部高分条件，跨会话复用价值最高；
 * 2. Constraint —— 明确约束类且重要性达标，注入 Runtime Context；
 * 3. Candidate  —— 有一定价值但尚未验证，进入观察期；
 * 4. Discard    —— 价值不足，直接丢弃。
 */
@Injectable()
export class MemoryDecisionService {
  /** 对单条候选做分流决策。 */
  decide(candidate: MemoryCandidate): MemoryDecision {
    if (this.qualifiesPersistent(candidate)) {
      return {
        kind: 'persistent',
        candidate,
        reason: 'high_persistence_intent_and_reusability',
      };
    }

    if (this.isConstraint(candidate)) {
      return {
        kind: 'constraint',
        candidate,
        reason: 'explicit_constraint',
      };
    }

    if (this.qualifiesCandidate(candidate)) {
      return {
        kind: 'candidate',
        candidate,
        reason: 'pending_observation',
      };
    }

    return {
      kind: 'discard',
      candidate,
      reason: 'below_threshold',
    };
  }

  private qualifiesPersistent(candidate: MemoryCandidate): boolean {
    const limits = MEMORY_DECISION_THRESHOLDS.persistent;
    const { scores } = candidate;

    return (
      scores.persistenceIntent >= limits.persistenceIntent &&
      scores.stability >= limits.stability &&
      scores.reusability >= limits.reusability &&
      scores.importance >= limits.importance
    );
  }

  private isConstraint(candidate: MemoryCandidate): boolean {
    if (candidate.type !== 'constraint') {
      return false;
    }

    return (
      candidate.scores.importance >=
      MEMORY_DECISION_THRESHOLDS.constraint.importance
    );
  }

  private qualifiesCandidate(candidate: MemoryCandidate): boolean {
    const limits = MEMORY_DECISION_THRESHOLDS.candidate;
    const { scores } = candidate;

    return (
      scores.importance >= limits.importance ||
      scores.reusability >= limits.importance
    );
  }
}
