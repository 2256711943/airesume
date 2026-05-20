import { INestApplication, Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaLibSql } from '@prisma/adapter-libsql';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  constructor() {
    const url = process.env.DATABASE_URL ?? 'file:./dev.db';
    const adapter = new PrismaLibSql({ url });
    super({ adapter });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  enableShutdownHooks(app: INestApplication): void {
    process.on('beforeExit', async () => {
      await app.close();
    });
  }
}
