import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  Min,
} from 'class-validator';
import {
  OBSERVABILITY_EVENT_TYPES,
  type ObservabilityEventType,
} from '../../observability.types';

/**
 * 规整 types 查询参数：支持逗号分隔字符串（?types=a,b）与重复参数（?types=a&types=b）。
 */
function normalizeTypesParam(
  value: unknown,
): ObservabilityEventType[] | undefined {
  if (Array.isArray(value)) {
    return value.filter(
      (item): item is ObservabilityEventType =>
        typeof item === 'string' && item.length > 0,
    );
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0) as ObservabilityEventType[];
  }

  return undefined;
}

/**
 * GET /observability/runs/:runId/events 的查询参数。
 *
 * 仅支持按 seq 范围与事件类型过滤；超出 DTO 声明范围的参数会被
 * 全局 ValidationPipe（whitelist + forbidNonWhitelisted）拒绝。
 */
export class ObservabilityRunEventsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  seqGt?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  seqGte?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  seqLte?: number;

  @IsOptional()
  @Transform(({ value }) => normalizeTypesParam(value))
  @IsArray()
  @IsEnum(OBSERVABILITY_EVENT_TYPES, { each: true })
  types?: ObservabilityEventType[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}
