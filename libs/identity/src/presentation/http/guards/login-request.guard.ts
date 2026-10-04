import { createValidationPipe } from '@app/common';
import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { LoginDto } from '../dto/login.dto.js';

/**
 * Validates + normalises the login body BEFORE `LocalAuthGuard` runs: guards execute before
 * pipes, so without this the passport strategy would see raw input, and a validation failure
 * raised inside passport would surface as a 401 instead of the standard 400. Uses the exact
 * global ValidationPipe configuration (same error body as every other endpoint).
 *
 * Usage: `@UseGuards(LoginRequestGuard, LocalAuthGuard)` (guards run in the listed order).
 */
@Injectable()
export class LoginRequestGuard implements CanActivate {
  private readonly pipe = createValidationPipe();

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const request = context.switchToHttp().getRequest<{ body?: unknown }>();
    request.body = await this.pipe.transform(request.body, {
      type: 'body',
      metatype: LoginDto,
      data: undefined,
    });
    return true;
  }
}
