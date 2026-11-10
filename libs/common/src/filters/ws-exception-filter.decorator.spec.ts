import { describe, expect, it } from 'vitest';
import { AllExceptionsFilter } from './all-exceptions.filter.js';
import { UseWsExceptionFilter } from './ws-exception-filter.decorator.js';

describe('UseWsExceptionFilter', () => {
  it('binds AllExceptionsFilter (global filters never reach @WebSocketGateway)', () => {
    @UseWsExceptionFilter()
    class Gateway {}
    expect(Reflect.getMetadata('__exceptionFilters__', Gateway)).toEqual([AllExceptionsFilter]);
  });
});
