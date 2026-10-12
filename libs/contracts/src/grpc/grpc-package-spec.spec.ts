import { describe, expect, it } from 'vitest';
import {
  GRPC_LOADER_OPTIONS,
  type GrpcPackageSpec,
  resolveGrpcPackages,
} from './grpc-package-spec.js';

const ORDERS: GrpcPackageSpec = {
  package: 'orders.v1',
  protoDir: '/contracts/orders/proto',
  protoPath: ['orders/v1/orders.proto'],
  services: ['OrdersService', 'CartsService'],
  clientToken: 'ORDERS_GRPC_CLIENT',
  idempotentMethods: { OrdersService: ['GetOrder', 'ListOrders'] },
};

const SHIPPING: GrpcPackageSpec = {
  package: 'shipping.v1',
  protoDir: '/contracts/shipping/proto',
  protoPath: ['shipping/v1/shipping.proto'],
  services: ['ShippingService'],
  clientToken: 'SHIPPING_GRPC_CLIENT',
  idempotentMethods: {},
};

describe('resolveGrpcPackages', () => {
  it('keeps input order, drops a package listed twice and merges the include dirs', () => {
    expect(resolveGrpcPackages([SHIPPING, ORDERS, { ...SHIPPING }])).toEqual({
      packages: ['shipping.v1', 'orders.v1'],
      protoPath: ['shipping/v1/shipping.proto', 'orders/v1/orders.proto'],
      includeDirs: ['/contracts/shipping/proto', '/contracts/orders/proto'],
      services: [
        'shipping.v1.ShippingService',
        'orders.v1.OrdersService',
        'orders.v1.CartsService',
      ],
      idempotentMethods: [
        { service: 'orders.v1.OrdersService', method: 'GetOrder' },
        { service: 'orders.v1.OrdersService', method: 'ListOrders' },
      ],
    });
  });

  it('shares one include dir between packages of the same contracts package', () => {
    const carts: GrpcPackageSpec = {
      ...ORDERS,
      package: 'carts.v1',
      protoPath: ['carts/v1/carts.proto'],
    };
    expect(resolveGrpcPackages([ORDERS, carts]).includeDirs).toEqual(['/contracts/orders/proto']);
  });

  it('returns empty arrays for no packages', () => {
    expect(resolveGrpcPackages([])).toEqual({
      packages: [],
      protoPath: [],
      includeDirs: [],
      services: [],
      idempotentMethods: [],
    });
  });
});

describe('GRPC_LOADER_OPTIONS', () => {
  it('mirrors the ts-proto options and leaves includeDirs to each call', () => {
    expect(GRPC_LOADER_OPTIONS).toEqual({
      keepCase: false,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    });
  });
});
