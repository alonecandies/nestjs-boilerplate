import { GenericContainer, Wait } from 'testcontainers';

/** Same tags as the `rustfs` and `gcs` services of docker-compose.yml (emulator-images.spec.ts). */
export const RUSTFS_IMAGE = 'rustfs/rustfs:1.0.0';
export const FAKE_GCS_IMAGE = 'fsouza/fake-gcs-server:1.56.1';
export const EMULATOR_ACCESS_KEY = 'rustfsadmin';
export const EMULATOR_SECRET_KEY = 'rustfsadmin';
export const EMULATOR_BUCKET = 'uploads';
export const EMULATOR_GCS_PROJECT = 'local-project';

/**
 * Two names for the same published port, like a browser (public) and the API (in-cluster): the
 * presigned URL is signed for one and the driver talks to the other. fake-gcs serves signed URLs
 * on `-public-host`; given without a port, it matches every port of that host name. Needs a local
 * Docker daemon (as in CI).
 */
export const PUBLIC_HOST = 'localhost';
export const INTERNAL_HOST = '127.0.0.1';

export interface RunningEmulator {
  /** Endpoint the driver talks to (uploads, HEAD, DELETE, bucket admin). */
  readonly internalEndpoint: string;
  /** Endpoint baked into presigned URLs: same port, other host name. */
  readonly publicEndpoint: string;
  stop(): Promise<void>;
}

async function start(container: GenericContainer, port: number): Promise<RunningEmulator> {
  const started = await container.start();
  const mapped = started.getMappedPort(port);
  return {
    internalEndpoint: `http://${INTERNAL_HOST}:${mapped}`,
    publicEndpoint: `http://${PUBLIC_HOST}:${mapped}`,
    stop: async () => {
      await started.stop();
    },
  };
}

/** RustFS (S3), configured like the compose `rustfs` service. */
export function startRustfs(): Promise<RunningEmulator> {
  return start(
    new GenericContainer(RUSTFS_IMAGE)
      .withEnvironment({
        RUSTFS_VOLUMES: '/data',
        RUSTFS_ADDRESS: '0.0.0.0:9000',
        RUSTFS_ACCESS_KEY: EMULATOR_ACCESS_KEY,
        RUSTFS_SECRET_KEY: EMULATOR_SECRET_KEY,
        RUSTFS_OBS_LOGGER_LEVEL: 'warn',
      })
      .withExposedPorts(9000)
      .withWaitStrategy(Wait.forHttp('/health', 9000).forStatusCode(200)),
    9000,
  );
}

/** fake-gcs-server (GCS), in-memory backend; flags appended to its `-data /data` entrypoint. */
export function startFakeGcs(): Promise<RunningEmulator> {
  return start(
    new GenericContainer(FAKE_GCS_IMAGE)
      .withCommand([
        '-scheme',
        'http',
        '-port',
        '4443',
        '-public-host',
        PUBLIC_HOST,
        '-backend',
        'memory',
        '-log-level',
        'warn',
      ])
      .withExposedPorts(4443)
      .withWaitStrategy(Wait.forHttp('/_internal/healthcheck', 4443).forStatusCode(200)),
    4443,
  );
}
