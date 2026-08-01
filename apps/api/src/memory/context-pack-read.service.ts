import { Injectable } from '@nestjs/common';
import type { ContextPack } from './context-pack.types';
import { ContextPackStore } from './memory.store';

@Injectable()
export class ContextPackReadService {
  constructor(private readonly contextPackStore: ContextPackStore) {}

  async getLatestForConversation(
    conversationId: string,
  ): Promise<ContextPack | null> {
    return this.contextPackStore.getLatest({
      conversationId,
    });
  }

  async listConversationHistory(
    conversationId: string,
    limit: number,
  ): Promise<ContextPack[]> {
    return this.contextPackStore.list({
      conversationId,
      limit,
      orderBy: {
        field: 'generatedAt',
        direction: 'desc',
      },
    });
  }

  async getConversationPack(
    conversationId: string,
    packId: string,
  ): Promise<ContextPack | null> {
    const pack = await this.contextPackStore.get(packId);
    if (!pack || pack.conversationId !== conversationId) {
      return null;
    }

    return pack;
  }
}
