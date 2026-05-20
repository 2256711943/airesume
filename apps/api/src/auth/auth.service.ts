import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { compare } from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { LoginDto } from './dto/login.dto';

@Injectable()
export class AuthService {
  private readonly expiresInSeconds = Number(process.env.JWT_EXPIRES_IN_SECONDS ?? 7200);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

  async login(dto: LoginDto): Promise<{ accessToken: string; expiresIn: number }> {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase() },
      select: {
        id: true,
        email: true,
        name: true,
        passwordHash: true,
      },
    });

    if (!user) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const passwordMatched = await compare(dto.password, user.passwordHash);
    if (!passwordMatched) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const accessToken = await this.jwtService.signAsync({
      sub: user.id,
      email: user.email,
      name: user.name,
    });

    return { accessToken, expiresIn: this.expiresInSeconds };
  }

  logout(): { acknowledged: boolean } {
    return { acknowledged: true };
  }

  me(user: { id: string; email: string; name: string }): { id: string; email: string; name: string } {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
    };
  }
}
