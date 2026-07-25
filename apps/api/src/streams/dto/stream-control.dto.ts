import { Type } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export enum StreamControlLevel {
  Normal = 'normal',
  High = 'high',
  Critical = 'critical',
}

export class StreamControlHintsDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  minProgressIntervalMs?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  textChunkTargetChars?: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  suppressTypes?: string[];
}

export class StreamControlDto {
  @IsEnum(StreamControlLevel)
  level!: StreamControlLevel;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  ttlMs!: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => StreamControlHintsDto)
  hints?: StreamControlHintsDto;
}
