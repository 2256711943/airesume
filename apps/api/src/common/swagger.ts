import { applyDecorators, HttpStatus, type Type } from '@nestjs/common';
import {
  ApiExtraModels,
  ApiResponse,
  getSchemaPath,
} from '@nestjs/swagger';

export function ApiSuccessResponse<TModel extends Type<unknown>>(
  model: TModel,
  status = HttpStatus.OK,
): MethodDecorator {
  return applyDecorators(
    ApiExtraModels(model),
    ApiResponse({
      status,
      schema: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: true },
          data: { $ref: getSchemaPath(model) },
          error: { type: 'null', example: null },
          requestId: { type: 'string', example: 'req_xxx' },
        },
        required: ['success', 'data', 'error', 'requestId'],
      },
    }),
  );
}
