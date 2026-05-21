import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateProductDto } from './dto/create-product.dto';
import { ProductDto } from './dto/product.dto';

interface CsvRow {
  name: string;
  category: string;
  sellingPoints: string[];
  targetAudience: string;
  platform: string;
  tone: string;
  bannedTerms: string[];
}

@Injectable()
export class ProductsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(userId: string, dto: CreateProductDto): Promise<ProductDto> {
    const product = await this.prisma.product.create({
      data: {
        userId,
        name: dto.name,
        category: dto.category,
        sellingPoints: dto.sellingPoints,
        targetAudience: dto.targetAudience,
        platform: dto.platform,
        tone: dto.tone,
        bannedTerms: dto.bannedTerms ?? [],
      },
    });

    return {
      id: product.id,
      name: product.name,
      category: product.category,
      sellingPoints: this.toStringArray(product.sellingPoints),
      targetAudience: product.targetAudience,
      platform: product.platform,
      tone: product.tone,
      bannedTerms: this.toStringArray(product.bannedTerms),
    };
  }

  async list(userId: string): Promise<ProductDto[]> {
    const products = await this.prisma.product.findMany({
      where: { userId },
      orderBy: {
        createdAt: 'desc',
      },
    });

    return products.map((product) => ({
      id: product.id,
      name: product.name,
      category: product.category,
      sellingPoints: this.toStringArray(product.sellingPoints),
      targetAudience: product.targetAudience,
      platform: product.platform,
      tone: product.tone,
      bannedTerms: this.toStringArray(product.bannedTerms),
    }));
  }

  async importCsv(userId: string, csvContent: string): Promise<{ importedCount: number }> {
    const rows = this.parseCsv(csvContent);
    if (rows.length === 0) {
      return { importedCount: 0 };
    }

    await this.prisma.product.createMany({
      data: rows.map((row) => ({
        userId,
        name: row.name,
        category: row.category,
        sellingPoints: row.sellingPoints,
        targetAudience: row.targetAudience,
        platform: row.platform,
        tone: row.tone,
        bannedTerms: row.bannedTerms,
      })),
    });

    return { importedCount: rows.length };
  }

  private toStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value.map((item) => String(item));
  }

  private parseCsv(csvContent: string): CsvRow[] {
    const lines = csvContent
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (lines.length <= 1) {
      return [];
    }

    const rows: CsvRow[] = [];

    for (const line of lines.slice(1)) {
      const cells = line.split(',').map((cell) => cell.trim());
      if (cells.length < 6) {
        continue;
      }

      const row = {
        name: cells[0] ?? '',
        category: cells[1] ?? '',
        sellingPoints: this.splitPipeList(cells[2] ?? ''),
        targetAudience: cells[3] ?? '',
        platform: cells[4] ?? '',
        tone: cells[5] ?? '',
        bannedTerms: this.splitPipeList(cells[6] ?? ''),
      };

      if (
        row.name.length === 0 ||
        row.category.length === 0 ||
        row.targetAudience.length === 0 ||
        row.platform.length === 0 ||
        row.tone.length === 0 ||
        row.sellingPoints.length === 0
      ) {
        continue;
      }

      rows.push(row);
    }

    return rows;
  }

  private splitPipeList(value: string): string[] {
    return value
      .split('|')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }
}
