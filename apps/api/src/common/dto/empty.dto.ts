import { ApiProperty } from '@nestjs/swagger';

export class EmptyDto {
  @ApiProperty({ example: true })
  acknowledged!: boolean;
}
