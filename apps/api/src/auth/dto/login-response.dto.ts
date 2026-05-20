import { ApiProperty } from '@nestjs/swagger';

export class LoginResponseDto {
  @ApiProperty({ example: 'token_sample' })
  accessToken!: string;

  @ApiProperty({ example: 7200, description: 'Access token ttl in seconds' })
  expiresIn!: number;
}
