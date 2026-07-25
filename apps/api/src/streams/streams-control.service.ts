import { Injectable } from '@nestjs/common';
import {
  getReplayableSseSession,
  type SseStreamControlHints,
  type SseStreamControlState,
} from '../common/sse-session';
import { StreamControlDto, StreamControlLevel } from './dto/stream-control.dto';

const ALWAYS_ALLOWED_EVENT_TYPES = new Set(['done', 'error', 'canceled', 'checkpoint']);

@Injectable()
export class StreamsControlService {
  applyControl(streamKey: string, dto: StreamControlDto): boolean {
    const session = getReplayableSseSession(streamKey);
    if (!session) {
      return false;
    }

    if (dto.level === StreamControlLevel.Normal) {
      session.clearControlState();
      return true;
    }

    const ttlMs = this.normalizePositiveInt(dto.ttlMs);
    if (ttlMs === null) {
      session.clearControlState();
      return true;
    }

    const hints = this.normalizeHints(dto.hints);
    const state: SseStreamControlState = {
      level: dto.level,
      expiresAt: Date.now() + ttlMs,
      hints,
    };

    session.setControlState(state);
    return true;
  }

  private normalizeHints(
    hints: StreamControlDto['hints'],
  ): SseStreamControlHints {
    const normalized: SseStreamControlHints = {};

    const minProgressIntervalMs = this.normalizePositiveInt(
      hints?.minProgressIntervalMs,
    );
    if (minProgressIntervalMs !== null) {
      normalized.minProgressIntervalMs = minProgressIntervalMs;
    }

    const textChunkTargetChars = this.normalizePositiveInt(
      hints?.textChunkTargetChars,
    );
    if (textChunkTargetChars !== null) {
      normalized.textChunkTargetChars = textChunkTargetChars;
    }

    const suppressTypes = Array.from(
      new Set(
        (hints?.suppressTypes ?? [])
          .map((type) => type.trim())
          .filter((type) => type.length > 0)
          .filter((type) => !ALWAYS_ALLOWED_EVENT_TYPES.has(type)),
      ),
    );
    if (suppressTypes.length > 0) {
      normalized.suppressTypes = suppressTypes;
    }

    return normalized;
  }

  private normalizePositiveInt(value: number | undefined): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return null;
    }

    const normalized = Math.floor(value);
    return normalized > 0 ? normalized : null;
  }
}
