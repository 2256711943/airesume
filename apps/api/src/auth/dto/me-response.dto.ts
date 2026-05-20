import { ApiProperty } from '@nestjs/swagger';

export class MeResponseDto {
  @ApiProperty({ example: 'user_001' })
  id!: string;

  @ApiProperty({ example: 'user@example.com' })
  email!: string;

  @ApiProperty({ example: 'Demo User' })
  name!: string;
}
