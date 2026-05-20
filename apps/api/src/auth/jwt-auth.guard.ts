import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { RequestWithId } from '../common/request-id.middleware';

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
}

export interface AuthenticatedRequest extends RequestWithId {
  user?: AuthenticatedUser;
}

interface JwtPayload {
  sub: string;
  email: string;
  name: string;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly jwtService = new JwtService({
    secret: process.env.JWT_SECRET ?? 'dev_jwt_secret_change_me',
  });

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authHeader = req.header('authorization');
    const token = this.extractBearerToken(authHeader);

    if (!token) {
      throw new UnauthorizedException('Missing bearer token');
    }

    try {
      const payload = await this.jwtService.verifyAsync<JwtPayload>(token);
      req.user = {
        id: payload.sub,
        email: payload.email,
        name: payload.name,
      };
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }

  private extractBearerToken(authHeader: string | undefined): string | null {
    if (!authHeader) {
      return null;
    }

    const [scheme, token] = authHeader.split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      return null;
    }

    return token.trim();
  }
}
