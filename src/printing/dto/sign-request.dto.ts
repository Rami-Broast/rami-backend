import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class SignPrintRequestDto {
  /**
   * The string QZ Tray asked the browser to have signed.
   *
   * Capped because this endpoint signs what it is given: a bound keeps a
   * mistake or an abusive caller from turning it into a general-purpose
   * signing service for large documents. A QZ request is a few hundred bytes.
   */
  @ApiProperty({ description: 'The exact string QZ Tray passed to the signature promise.' })
  @IsString()
  @MinLength(1)
  @MaxLength(8192)
  request!: string;
}
