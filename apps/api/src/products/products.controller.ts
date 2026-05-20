import { Body, Controller, Get, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ok } from '../common/api-response';
import type { ApiResponse } from '../common/api-response';
import type { RequestWithId } from '../common/request-id.middleware';
import { ApiSuccessResponse } from '../common/swagger';
import { CreateProductDto } from './dto/create-product.dto';
import { ImportCsvResponseDto } from './dto/import-csv-response.dto';
import { ImportCsvDto } from './dto/import-csv.dto';
import { ProductListDto } from './dto/product-list.dto';
import { ProductDto } from './dto/product.dto';
import { ProductsService } from './products.service';

@ApiTags('products')
@Controller('products')
@UseGuards(JwtAuthGuard)
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Post()
  @ApiOperation({ summary: 'Create product' })
  @ApiSuccessResponse(ProductDto, HttpStatus.CREATED)
  create(
    @Body() dto: CreateProductDto,
    @Req() req: RequestWithId,
  ): ApiResponse<ProductDto> {
    return ok(req.requestId ?? 'unknown', this.productsService.create(dto));
  }

  @Get()
  @ApiOperation({ summary: 'List products' })
  @ApiSuccessResponse(ProductListDto)
  list(@Req() req: RequestWithId): ApiResponse<ProductListDto> {
    return ok(req.requestId ?? 'unknown', { items: this.productsService.list() });
  }

  @Post('import-csv')
  @ApiOperation({ summary: 'Import products from CSV' })
  @ApiSuccessResponse(ImportCsvResponseDto)
  importCsv(
    @Body() dto: ImportCsvDto,
    @Req() req: RequestWithId,
  ): ApiResponse<ImportCsvResponseDto> {
    return ok(req.requestId ?? 'unknown', this.productsService.importCsv(dto.csvContent));
  }
}
