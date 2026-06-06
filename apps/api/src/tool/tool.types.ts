export type ToolName = 'jd_parse_and_score';

export interface ToolExecutionError {
  code: string;
  message: string;
}

export interface ToolExecutionResult<TData> {
  success: boolean;
  toolName: ToolName;
  data: TData | null;
  error: ToolExecutionError | null;
  latencyMs: number;
  sourceMeta: {
    source: 'internal';
    version: string;
  };
}

export interface JdParseAndScoreToolInput {
  jdText: string;
}

export interface JdParseAndScoreToolOutput {
  parsedJd: unknown;
  judge: unknown;
}
