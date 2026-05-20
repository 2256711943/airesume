import { Injectable } from '@nestjs/common';
import { CreateProductDto } from './dto/create-product.dto';
import { ProductDto } from './dto/product.dto';

@Injectable()
export class ProductsService {
  create(dto: CreateProductDto): ProductDto {
    return {
      id: 'prod_001',
      name: dto.name,
      category: dto.category,
      sellingPoints: dto.sellingPoints,
      targetAudience: dto.targetAudience,
      platform: dto.platform,
      tone: dto.tone,
      bannedTerms: dto.bannedTerms,
    };
  }

  list(): ProductDto[] {
    return [];
  }

  importCsv(csvContent: string): { importedCount: number } {
    const lines = csvContent.split('\n').filter((line) => line.trim().length > 0);
    const importedCount = Math.max(0, lines.length - 1);
    return { importedCount };
  }
}
