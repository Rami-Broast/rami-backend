import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

/** E.164: a leading +, then 8–15 digits, first digit non-zero. */
const E164 = /^\+[1-9]\d{7,14}$/;

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class RequestOtpDto {
  @ApiProperty({ example: '+966500000000', description: 'Phone number in E.164 format.' })
  @Transform(trim)
  @IsString()
  @Matches(E164, { message: 'phone must be a valid E.164 number, e.g. +966500000000' })
  phone!: string;
}

export class VerifyOtpDto {
  @ApiProperty({ example: '+966500000000' })
  @Transform(trim)
  @IsString()
  @Matches(E164, { message: 'phone must be a valid E.164 number, e.g. +966500000000' })
  phone!: string;

  @ApiProperty({ example: '123456', description: 'The code delivered by SMS.' })
  @Transform(trim)
  @IsString()
  @Matches(/^\d{4,10}$/, { message: 'code must be 4 to 10 digits' })
  code!: string;
}

export class StaffLoginDto {
  @ApiProperty({ example: 'owner@example.com' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsString()
  @MaxLength(320)
  email!: string;

  // Login intentionally does NOT validate password format or length. Length and
  // strength rules belong at account creation (`scripts/create-staff-user.ts`
  // enforces MINIMUM_PASSWORD_LENGTH there). On sign-in we only guard against
  // an absurdly long body; whether the value is right or wrong is answered by
  // the auth service with a generic "wrong email or password" so the response
  // leaks no information about the password policy.
  @ApiProperty({ example: 'a strong password' })
  @IsString()
  @MaxLength(512)
  password!: string;
}

export class RefreshTokenDto {
  @ApiProperty({ description: 'The refresh token issued alongside the last access token.' })
  @IsString()
  @MinLength(20)
  @MaxLength(512)
  refreshToken!: string;
}

export class AuthTokensDto {
  @ApiProperty({ description: 'Bearer token for the Authorization header.' })
  accessToken!: string;

  @ApiProperty({
    description:
      'Single-use refresh token. Rotated on every refresh — store the new one and discard the old.',
  })
  refreshToken!: string;

  @ApiProperty({ example: 900, description: 'Access token lifetime in seconds.' })
  expiresInSeconds!: number;

  @ApiProperty({ example: 'Bearer' })
  tokenType!: string;
}

export class OtpRequestedDto {
  @ApiProperty({ description: 'When the code stops being accepted.' })
  expiresAt!: Date;

  @ApiProperty({
    example: 'A verification code has been sent.',
    description:
      'Deliberately identical whether or not the number is registered, so the endpoint cannot be used to discover customers.',
  })
  message!: string;
}

export class CurrentActorDto {
  @ApiProperty({ enum: ['STAFF', 'CUSTOMER'] })
  kind!: string;

  @ApiProperty()
  id!: string;

  @ApiPropertyOptional({ description: 'Staff only.' })
  email?: string;

  @ApiPropertyOptional({ description: 'Staff only.' })
  fullName?: string;

  @ApiPropertyOptional({ description: 'Customer only.' })
  phone?: string;

  @ApiProperty({ type: [String] })
  roles!: string[];

  @ApiProperty({ type: [String] })
  permissions!: string[];

  @ApiProperty({
    example: { kind: 'ASSIGNED', branchIds: ['...'] },
    description: 'ALL for owners, ASSIGNED with a branch list, or NONE.',
  })
  branchScope!: { kind: string; branchIds?: string[] };
}
