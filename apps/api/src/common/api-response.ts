export interface ApiError {
  code: string;
  message: string;
}

export interface ApiResponse<T> {
  success: boolean;
  data: T | null;
  error: ApiError | null;
  requestId: string;
}

export function ok<T>(requestId: string, data: T): ApiResponse<T> {
  return {
    success: true,
    data,
    error: null,
    requestId,
  };
}
