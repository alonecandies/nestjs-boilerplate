import {
  type ExecutionContext,
  Inject,
  Injectable,
  Logger,
  Module,
  Optional,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { UnknownElementException } from '@nestjs/core/errors/exceptions/unknown-element.exception.js';
import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { MAINTENANCE_MODE } from '../constants/tokens.constants.js';
import { ServiceUnavailableException } from '../errors/domain.exception.js';
import { toProblemDetails } from '../errors/problem-details.js';
import {
  provideCommonEnhancers,
  provideCommonEnhancersAsync,
} from '../providers/common-enhancers.js';
import type { MaintenanceModeSwitch } from './maintenance-mode.middleware.js';
import { maintenanceProblem } from './maintenance-mode.middleware.js';
import {
  createMaintenanceModeReader,
  MAINTENANCE_SWITCH_FAULT_LOG_INTERVAL_MS,
} from './maintenance-mode.reader.js';
import { WsMaintenanceGuard } from './ws-maintenance.guard.js';

/** A provider of a feature module, which is where the WebSocket entry points live. */
@Injectable()
class FeatureReader {
  readonly read: () => boolean;

  constructor(
    @Inject(ModuleRef) moduleRef: ModuleRef,
    @Optional() @Inject(MAINTENANCE_MODE) readonly injected?: MaintenanceModeSwitch,
  ) {
    this.read = createMaintenanceModeReader(moduleRef);
  }
}

@Module({ providers: [FeatureReader, WsMaintenanceGuard], exports: [FeatureReader] })
class FeatureModule {}

/** An app whose root module provides the switch, read from the feature module. */
async function appWithSwitch(mode: MaintenanceModeSwitch | undefined) {
  @Module({
    imports: [FeatureModule],
    providers: mode === undefined ? [] : provideCommonEnhancers({ maintenanceMode: mode }),
  })
  class RootModule {}
  const app = await Test.createTestingModule({ imports: [RootModule] }).compile();
  return {
    reader: app.get(FeatureReader),
    guard: app.get(WsMaintenanceGuard),
  };
}

const context = (type: string): ExecutionContext =>
  ({ getType: () => type }) as unknown as ExecutionContext;

let logError: MockInstance<Logger['error']>;

beforeEach(() => {
  logError = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createMaintenanceModeReader', () => {
  it("reads the root module's switch from another module, where @Optional() injection sees none", async () => {
    const { reader } = await appWithSwitch(true);

    expect(reader.injected).toBeUndefined(); // the silent "off" this reader exists to avoid
    expect(reader.read()).toBe(true);
  });

  it('follows a function switch at every read', async () => {
    let on = false;
    const { reader } = await appWithSwitch(() => on);

    expect(reader.read()).toBe(false);
    on = true;
    expect(reader.read()).toBe(true);
    on = false;
    expect(reader.read()).toBe(false);
  });

  it('reads off when the app provides no switch (a service, a unit spec)', async () => {
    const { reader } = await appWithSwitch(undefined);

    expect(reader.read()).toBe(false);
  });

  it('looks the switch up once, at the first read, not at construction', () => {
    const get = vi.fn(() => true);
    const read = createMaintenanceModeReader({ get } as unknown as ModuleRef);

    expect(get).not.toHaveBeenCalled();
    expect(read()).toBe(true);
    expect(read()).toBe(true);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(MAINTENANCE_MODE, { strict: false });
  });

  it.each([
    ['undefined', undefined],
    ['null (what Nest returns for a provider not instantiated yet)', null],
  ])(
    'a switch not built yet (%s) reads off and is looked up again at the next read',
    (_, notBuilt) => {
      const get = vi.fn<() => MaintenanceModeSwitch | null | undefined>(() => notBuilt);
      const read = createMaintenanceModeReader({ get } as unknown as ModuleRef);

      expect(read()).toBe(false);
      get.mockReturnValue(true);
      expect(read()).toBe(true);
      expect(get).toHaveBeenCalledTimes(2);
    },
  );

  it('a read while the app is still being built reads off, and the built switch is read later', async () => {
    /** Reads in its constructor, beside a switch whose (async) options are not resolved yet. */
    @Injectable()
    class EarlyReader {
      readonly read: () => boolean;
      readonly duringBuild: boolean;

      constructor(@Inject(ModuleRef) moduleRef: ModuleRef) {
        this.read = createMaintenanceModeReader(moduleRef);
        this.duringBuild = this.read();
      }
    }
    @Module({
      providers: [
        EarlyReader,
        ...provideCommonEnhancersAsync({
          useFactory: async () => {
            await Promise.resolve();
            return { maintenanceMode: true };
          },
        }),
      ],
    })
    class RootModule {}

    const app = await Test.createTestingModule({ imports: [RootModule] }).compile();
    const early = app.get(EarlyReader);

    expect(early.duringBuild).toBe(false);
    expect(early.read()).toBe(true);
  });

  it('a switch in no module ("not found") reads off for good, without logging', () => {
    const get = vi.fn(() => {
      throw new UnknownElementException('MAINTENANCE_MODE');
    });
    const read = createMaintenanceModeReader({ get } as unknown as ModuleRef);

    expect(read()).toBe(false);
    expect(read()).toBe(false);
    expect(get).toHaveBeenCalledTimes(1);
    expect(logError).not.toHaveBeenCalled();
  });

  describe('fails closed: a switch it cannot read answers on', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('a switch that throws reads on, never throws, and is logged once per window', async () => {
      const { reader } = await appWithSwitch(() => {
        throw new Error('flag store down');
      });

      for (let i = 0; i < 50; i += 1) expect(reader.read()).toBe(true);
      expect(logError).toHaveBeenCalledTimes(1);
      expect(String(logError.mock.calls[0]?.[0])).toContain('flag store down');

      vi.advanceTimersByTime(MAINTENANCE_SWITCH_FAULT_LOG_INTERVAL_MS - 1);
      expect(reader.read()).toBe(true);
      expect(logError).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(1);
      expect(reader.read()).toBe(true);
      expect(logError).toHaveBeenCalledTimes(2);
    });

    it('follows the switch again once it stops throwing', async () => {
      let fault = true;
      const { reader } = await appWithSwitch(() => {
        if (fault) throw new Error('flag store down');
        return false;
      });

      expect(reader.read()).toBe(true);
      fault = false;
      expect(reader.read()).toBe(false);
    });

    it('a lookup failure other than "not found" reads on, is logged, and is looked up again', () => {
      const get = vi.fn((): MaintenanceModeSwitch => {
        throw new Error('scope fault');
      });
      const read = createMaintenanceModeReader({ get } as unknown as ModuleRef);

      expect(read()).toBe(true);
      expect(read()).toBe(true);
      expect(logError).toHaveBeenCalledTimes(1);
      expect(String(logError.mock.calls[0]?.[0])).toContain('scope fault');

      get.mockReturnValue(false);
      expect(read()).toBe(false);
      expect(get).toHaveBeenCalledTimes(3);
    });
  });
});

describe('WsMaintenanceGuard', () => {
  it('refuses a WebSocket message with the maintenance 503 while the switch is on', async () => {
    const { guard } = await appWithSwitch(true);

    let thrown: unknown;
    try {
      guard.canActivate(context('ws'));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ServiceUnavailableException);
    expect(toProblemDetails(thrown, { exposeInternal: false })).toEqual(maintenanceProblem());
  });

  it('lets anything that is not a WebSocket message through, even while the switch is on', async () => {
    const { guard } = await appWithSwitch(true);

    for (const type of ['http', 'rpc', 'graphql']) {
      expect(guard.canActivate(context(type))).toBe(true);
    }
  });

  it('follows a function switch: off passes, on refuses, off passes again', async () => {
    let on = false;
    const { guard } = await appWithSwitch(() => on);

    expect(guard.canActivate(context('ws'))).toBe(true);
    on = true;
    expect(() => guard.canActivate(context('ws'))).toThrow(ServiceUnavailableException);
    on = false;
    expect(guard.canActivate(context('ws'))).toBe(true);
  });

  it('passes when the app provides no switch', async () => {
    const { guard } = await appWithSwitch(undefined);

    expect(guard.canActivate(context('ws'))).toBe(true);
  });

  it('refuses with the maintenance 503, not the raw error, while the switch throws', async () => {
    const { guard } = await appWithSwitch(() => {
      throw new Error('flag store down');
    });

    expect(() => guard.canActivate(context('ws'))).toThrow(ServiceUnavailableException);
  });
});
