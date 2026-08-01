import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ListConversationContextPacksDto } from './conversation-context-pack.dto';

describe('ListConversationContextPacksDto', () => {
  it('accepts the default limit', async () => {
    const dto = plainToInstance(ListConversationContextPacksDto, {});

    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
    expect(dto.limit).toBe(20);
  });

  it('rejects limits outside 1..50', async () => {
    const tooSmall = plainToInstance(ListConversationContextPacksDto, {
      limit: 0,
    });
    const tooLarge = plainToInstance(ListConversationContextPacksDto, {
      limit: 51,
    });

    const smallErrors = await validate(tooSmall);
    const largeErrors = await validate(tooLarge);

    expect(smallErrors).not.toHaveLength(0);
    expect(largeErrors).not.toHaveLength(0);
  });
});
