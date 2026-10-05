import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/**
 * A customer editing their own profile.
 *
 * Only the display name is editable here. The phone number is the OTP login
 * identity — changing it needs a fresh OTP verification flow, which is a
 * separate, later addition — so it is view-only in this endpoint.
 */
export class UpdateProfileDto {
  @ApiProperty({ minLength: 1, maxLength: 120 })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  fullName!: string;
}
