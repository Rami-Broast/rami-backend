import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { CurrentActor } from '../auth/decorators/current-actor.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import type { Actor } from '../auth/types/actor';
import { ApiErrorDto } from '../common/dto/api-error.dto';
import { BranchesService } from './branches.service';
import {
  ChangeBranchStatusDto,
  CreateBranchDto,
  DeleteBranchDto,
  DuplicateBranchDto,
  UpdateBranchDto,
} from './dto/branch.dto';

@ApiTags('branches (owner)')
@ApiResponse({ status: 401, type: ApiErrorDto })
@ApiResponse({ status: 403, type: ApiErrorDto })
@Controller('branches')
export class BranchesController {
  constructor(private readonly branches: BranchesService) {}

  @Get()
  @RequirePermissions('branches:read')
  @ApiOperation({ summary: 'List all branches' })
  list() {
    return this.branches.list();
  }

  @Get(':id')
  @RequirePermissions('branches:read')
  @ApiOperation({ summary: 'Get a branch by ID' })
  @ApiResponse({ status: 404, type: ApiErrorDto })
  findById(@Param('id', ParseUUIDPipe) id: string) {
    return this.branches.findById(id);
  }

  @Post()
  @RequirePermissions('branches:write')
  @ApiOperation({ summary: 'Create a new branch' })
  @ApiResponse({ status: 409, type: ApiErrorDto, description: 'Duplicate branch code.' })
  create(@Body() dto: CreateBranchDto) {
    return this.branches.create(dto);
  }

  @Patch(':id')
  @RequirePermissions('branches:write')
  @ApiOperation({ summary: 'Update branch details' })
  @ApiResponse({ status: 404, type: ApiErrorDto })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateBranchDto) {
    return this.branches.update(id, dto);
  }

  @Post(':id/status')
  @RequirePermissions('branches:write')
  @ApiOperation({ summary: 'Change branch lifecycle status' })
  @ApiResponse({ status: 404, type: ApiErrorDto })
  changeStatus(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ChangeBranchStatusDto) {
    return this.branches.changeStatus(id, dto);
  }

  @Post(':id/duplicate')
  @RequirePermissions('branches:write')
  @ApiOperation({
    summary: 'Duplicate a branch',
    description:
      'Copies settings and product availability. Does NOT copy orders, customers or transactions.',
  })
  @ApiResponse({ status: 404, type: ApiErrorDto })
  @ApiResponse({ status: 409, type: ApiErrorDto, description: 'Duplicate branch code.' })
  duplicate(@Param('id', ParseUUIDPipe) id: string, @Body() dto: DuplicateBranchDto) {
    return this.branches.duplicate(id, dto);
  }

  @Delete(':id')
  @RequirePermissions('branches:write')
  @ApiOperation({
    summary: 'Delete a branch',
    description:
      "Requires the operator's own password and the branch's code typed back. A branch that has never traded is removed completely; one that has is archived so its orders, settlements and VAT history survive. The response's `outcome` says which happened — never report one as the other.",
  })
  @ApiResponse({
    status: 400,
    type: ApiErrorDto,
    description: 'The confirmation code did not match.',
  })
  @ApiResponse({ status: 403, type: ApiErrorDto, description: 'The password was not correct.' })
  @ApiResponse({ status: 404, type: ApiErrorDto })
  remove(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DeleteBranchDto,
  ) {
    return this.branches.deleteBranch(actor, id, dto);
  }
}
