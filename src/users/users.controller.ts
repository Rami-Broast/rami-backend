import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { CurrentActor } from '../auth/decorators/current-actor.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { Actor } from '../auth/types/actor';
import { ApiErrorDto } from '../common/dto/api-error.dto';
import {
  AssignRoleDto,
  CreateUserDto,
  ListUsersQueryDto,
  ResetPasswordDto,
  UpdateUserDto,
} from './dto/user.dto';
import { UsersService } from './users.service';

/**
 * Staff-user administration (owner-only in the seed).
 *
 * Every mutation returns the full user view so the admin UI can render
 * the updated row without a follow-up GET.
 */
@ApiTags('users (staff)')
@ApiResponse({ status: 401, type: ApiErrorDto })
@ApiResponse({ status: 403, type: ApiErrorDto })
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Post()
  @RequirePermissions('users:write')
  @ApiOperation({ summary: 'Create a staff user, optionally granting one role in the same call' })
  @ApiResponse({ status: 400, type: ApiErrorDto, description: 'Invalid role/branch combination.' })
  @ApiResponse({
    status: 409,
    type: ApiErrorDto,
    description: 'A user with that email already exists.',
  })
  create(@Body() dto: CreateUserDto) {
    return this.users.create(dto);
  }

  @Get()
  @RequirePermissions('users:read')
  @ApiOperation({ summary: 'List staff users' })
  list(@Query() query: ListUsersQueryDto) {
    return this.users.list(query);
  }

  @Get(':id')
  @RequirePermissions('users:read')
  @ApiOperation({ summary: 'Get one staff user' })
  @ApiResponse({ status: 404, type: ApiErrorDto })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.users.getById(id);
  }

  @Patch(':id')
  @RequirePermissions('users:write')
  @ApiOperation({
    summary: 'Update a staff user',
    description:
      'Setting isActive=false deactivates the account and revokes every live session for that user.',
  })
  @ApiResponse({ status: 403, type: ApiErrorDto, description: 'Self-deactivation is refused.' })
  @ApiResponse({ status: 404, type: ApiErrorDto })
  update(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserDto,
  ) {
    return this.users.update(actor, id, dto);
  }

  @Post(':id/reset-password')
  @RequirePermissions('users:write')
  @ApiOperation({
    summary: 'Set a new password on behalf of a staff user',
    description:
      'Treats the previous password as compromised: every live session for that user is revoked.',
  })
  @ApiResponse({ status: 404, type: ApiErrorDto })
  resetPassword(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResetPasswordDto,
  ) {
    return this.users.resetPassword(actor, id, dto);
  }

  @Post(':id/roles')
  @RequirePermissions('roles:assign')
  @ApiOperation({ summary: 'Grant a role to a user, optionally scoped to a branch' })
  @ApiResponse({ status: 400, type: ApiErrorDto })
  @ApiResponse({ status: 404, type: ApiErrorDto })
  @ApiResponse({ status: 409, type: ApiErrorDto })
  assignRole(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AssignRoleDto) {
    return this.users.assignRole(id, dto);
  }

  @Delete(':id/roles/:userRoleId')
  @RequirePermissions('roles:assign')
  @ApiOperation({
    summary: 'Revoke a role assignment',
    description: 'Refuses to revoke the last active OWNER role in the organisation.',
  })
  @ApiResponse({ status: 403, type: ApiErrorDto })
  @ApiResponse({ status: 404, type: ApiErrorDto })
  revokeRole(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userRoleId', ParseUUIDPipe) userRoleId: string,
  ) {
    return this.users.revokeRole(actor, id, userRoleId);
  }
}
