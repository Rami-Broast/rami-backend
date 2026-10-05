import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { BranchScoped } from '../branches/decorators/branch-scoped.decorator';
import { ApiErrorDto } from '../common/dto/api-error.dto';
import {
  AttachModifierGroupDto,
  CreateAddonDto,
  CreateCategoryDto,
  CreateModifierGroupDto,
  CreateProductDto,
  CreateVariantDto,
  SetAvailabilityDto,
  UpdateAddonDto,
  UpdateCategoryDto,
  UpdateModifierGroupDto,
  UpdateProductDto,
  UpdateVariantDto,
} from './dto/menu.dto';
import { MenuService } from './menu.service';

/**
 * Catalog management for staff.
 *
 * Two permission levels, matching who is trusted with what:
 *
 *   `menu:write`        — the organisation-wide catalog. Owner only.
 *   `menu:availability` — what one branch currently sells, and at what price.
 *                         Branch admins hold this, scoped to their branches.
 */
@ApiTags('menu (admin)')
@ApiResponse({ status: 401, type: ApiErrorDto })
@ApiResponse({ status: 403, type: ApiErrorDto })
@Controller('menu')
export class MenuController {
  constructor(private readonly menu: MenuService) {}

  // --- Categories -----------------------------------------------------------

  @Get('categories')
  @RequirePermissions('menu:read')
  @ApiOperation({ summary: 'List categories' })
  listCategories(@Query('includeInactive') includeInactive?: string) {
    return this.menu.listCategories(includeInactive === 'true');
  }

  @Post('categories')
  @RequirePermissions('menu:write')
  @ApiOperation({ summary: 'Create a category' })
  createCategory(@Body() dto: CreateCategoryDto) {
    return this.menu.createCategory(dto);
  }

  @Patch('categories/:id')
  @RequirePermissions('menu:write')
  @ApiOperation({ summary: 'Update a category' })
  updateCategory(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCategoryDto) {
    return this.menu.updateCategory(id, dto);
  }

  @Delete('categories/:id')
  @RequirePermissions('menu:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Remove a category',
    description: 'Soft delete. Refused while the category still holds products.',
  })
  deleteCategory(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.menu.deleteCategory(id);
  }

  // --- Products -------------------------------------------------------------

  @Get('products')
  @RequirePermissions('menu:read')
  @ApiOperation({ summary: 'List products' })
  listProducts(
    @Query('categoryId') categoryId?: string,
    @Query('includeInactive') includeInactive?: string,
  ) {
    return this.menu.listProducts({ categoryId, includeInactive: includeInactive === 'true' });
  }

  @Get('products/:id')
  @RequirePermissions('menu:read')
  @ApiOperation({ summary: 'Get one product with variants and availability' })
  getProduct(@Param('id', ParseUUIDPipe) id: string) {
    return this.menu.getProduct(id);
  }

  @Post('products')
  @RequirePermissions('menu:write')
  @ApiOperation({
    summary: 'Create a product',
    description: 'Prices are in minor units (halalas) and are VAT inclusive.',
  })
  createProduct(@Body() dto: CreateProductDto) {
    return this.menu.createProduct(dto);
  }

  @Patch('products/:id')
  @RequirePermissions('menu:write')
  @ApiOperation({
    summary: 'Update a product',
    description:
      'Changing a price never alters past orders — each order carries its own price snapshot.',
  })
  updateProduct(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateProductDto) {
    return this.menu.updateProduct(id, dto);
  }

  @Delete('products/:id')
  @RequirePermissions('menu:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Remove a product',
    description: 'Soft delete, and every branch stops selling it immediately.',
  })
  deleteProduct(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.menu.deleteProduct(id);
  }

  // --- Variants -------------------------------------------------------------

  @Post('products/:productId/variants')
  @RequirePermissions('menu:write')
  @ApiOperation({
    summary: 'Add a variant to a product',
    description:
      'Price is absolute (minor units, VAT inclusive) and replaces the product base price.',
  })
  createVariant(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body() dto: CreateVariantDto,
  ) {
    return this.menu.createVariant(productId, dto);
  }

  @Patch('variants/:id')
  @RequirePermissions('menu:write')
  @ApiOperation({ summary: 'Update a variant' })
  updateVariant(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateVariantDto) {
    return this.menu.updateVariant(id, dto);
  }

  @Delete('variants/:id')
  @RequirePermissions('menu:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Remove a variant',
    description: 'Soft delete. Past orders keep their own price snapshot.',
  })
  deleteVariant(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.menu.deleteVariant(id);
  }

  // --- Modifier groups ------------------------------------------------------

  @Get('modifier-groups')
  @RequirePermissions('menu:read')
  @ApiOperation({ summary: 'List modifier groups with their add-ons' })
  listModifierGroups(@Query('includeInactive') includeInactive?: string) {
    return this.menu.listModifierGroups(includeInactive === 'true');
  }

  @Post('modifier-groups')
  @RequirePermissions('menu:write')
  @ApiOperation({ summary: 'Create a modifier group' })
  createModifierGroup(@Body() dto: CreateModifierGroupDto) {
    return this.menu.createModifierGroup(dto);
  }

  @Patch('modifier-groups/:id')
  @RequirePermissions('menu:write')
  @ApiOperation({ summary: 'Update a modifier group' })
  updateModifierGroup(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateModifierGroupDto) {
    return this.menu.updateModifierGroup(id, dto);
  }

  @Delete('modifier-groups/:id')
  @RequirePermissions('menu:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Remove a modifier group',
    description: 'Soft delete; also detaches it from every product it was on.',
  })
  deleteModifierGroup(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.menu.deleteModifierGroup(id);
  }

  // --- Add-ons --------------------------------------------------------------

  @Post('modifier-groups/:groupId/addons')
  @RequirePermissions('menu:write')
  @ApiOperation({ summary: 'Add an add-on to a modifier group' })
  createAddon(@Param('groupId', ParseUUIDPipe) groupId: string, @Body() dto: CreateAddonDto) {
    return this.menu.createAddon(groupId, dto);
  }

  @Patch('addons/:id')
  @RequirePermissions('menu:write')
  @ApiOperation({ summary: 'Update an add-on' })
  updateAddon(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateAddonDto) {
    return this.menu.updateAddon(id, dto);
  }

  @Delete('addons/:id')
  @RequirePermissions('menu:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove an add-on', description: 'Soft delete.' })
  deleteAddon(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.menu.deleteAddon(id);
  }

  // --- Attaching modifier groups to products --------------------------------

  @Post('products/:productId/modifier-groups')
  @RequirePermissions('menu:write')
  @ApiOperation({
    summary: 'Attach a modifier group to a product',
    description: 'Idempotent — re-attaching updates the sort order.',
  })
  attachModifierGroup(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body() dto: AttachModifierGroupDto,
  ) {
    return this.menu.attachModifierGroup(productId, dto);
  }

  @Delete('products/:productId/modifier-groups/:groupId')
  @RequirePermissions('menu:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Detach a modifier group from a product' })
  detachModifierGroup(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Param('groupId', ParseUUIDPipe) groupId: string,
  ): Promise<void> {
    return this.menu.detachModifierGroup(productId, groupId);
  }

  // --- Per-branch availability ---------------------------------------------

  @Get('branches/:branchId/availability')
  @RequirePermissions('menu:read')
  @BranchScoped('branchId')
  @ApiOperation({ summary: 'What this branch sells' })
  listAvailability(@Param('branchId', ParseUUIDPipe) branchId: string) {
    return this.menu.listAvailability(branchId);
  }

  @Patch('branches/:branchId/products/:productId/availability')
  @RequirePermissions('menu:availability')
  @BranchScoped('branchId')
  @ApiOperation({
    summary: 'Set availability and optional price override for one branch',
    description:
      'A branch admin may mark an item off or override its price for their own branch only. The branch is validated against the caller before this runs.',
  })
  setAvailability(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body() dto: SetAvailabilityDto,
  ) {
    return this.menu.setAvailability(branchId, productId, dto);
  }
}
