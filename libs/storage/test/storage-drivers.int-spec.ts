import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { CreateBucketCommand } from '@aws-sdk/client-s3';
import { storageConfig } from '@platform/config';
import {
  createGcsClient,
  createS3Client,
  GcsStorageDriver,
  S3_UPLOAD_PART_SIZE,
  S3StorageDriver,
  type StorageService,
} from '../src/index.js';
import {
  EMULATOR_ACCESS_KEY,
  EMULATOR_BUCKET,
  EMULATOR_GCS_PROJECT,
  EMULATOR_SECRET_KEY,
  startFakeGcs,
  startRustfs,
} from './emulators.js';

const INTEGRATION = process.env['INTEGRATION'] === '1';

interface DriverUnderTest {
  readonly storage: StorageService;
  /** Host baked into presigned URLs; differs from the endpoint the driver talks to. */
  readonly publicEndpoint: string;
  close(): Promise<void>;
}

const newKey = (name: string): string => `it/${randomUUID()}/${name}`;

/**
 * The behaviour every driver must show against a real (emulated) backend. `extra` registers
 * driver-specific cases inside the same describe (same container).
 */
function driverContract(
  name: string,
  boot: () => Promise<DriverUnderTest>,
  extra?: (current: () => DriverUnderTest) => void,
): void {
  describe.skipIf(!INTEGRATION)(`${name} against its emulator`, () => {
    let driver: DriverUnderTest | undefined;
    const current = (): DriverUnderTest => {
      if (driver === undefined) throw new Error('driver not booted');
      return driver;
    };

    beforeAll(async () => {
      driver = await boot();
    });
    afterAll(async () => {
      await driver?.close();
    });

    it('uploads a buffer; HEAD reports size, content type and metadata', async () => {
      const { storage } = current();
      const key = newKey('hello.txt');
      const stored = await storage.upload({
        key,
        body: Buffer.from('hello'),
        contentType: 'text/plain',
        metadata: { origin: 'int-spec' },
      });
      expect(stored).toMatchObject({ key, size: 5, contentType: 'text/plain' });
      const head = await storage.head(key);
      expect(head).toMatchObject({ key, size: 5, metadata: { origin: 'int-spec' } });
      expect(head?.contentType).toMatch(/^text\/plain/);
      expect(head?.lastModified).toBeInstanceOf(Date);
    });

    it('streams a body larger than one S3 multipart part', async () => {
      const { storage } = current();
      const key = newKey('big.bin');
      const size = S3_UPLOAD_PART_SIZE + 1024;
      const body = Readable.from([Buffer.alloc(S3_UPLOAD_PART_SIZE, 1), Buffer.alloc(1024, 2)]);
      const stored = await storage.upload({ key, body, contentType: 'application/octet-stream' });
      expect(stored.key).toBe(key);
      expect((await storage.head(key))?.size).toBe(size);
    });

    it('returns null for a missing key; DELETE is idempotent', async () => {
      const { storage } = current();
      expect(await storage.head(newKey('missing.txt'))).toBeNull();
      await expect(storage.delete(newKey('missing.txt'))).resolves.toBeUndefined();
      const key = newKey('gone.txt');
      await storage.upload({ key, body: Buffer.from('x'), contentType: 'text/plain' });
      await storage.delete(key);
      expect(await storage.head(key)).toBeNull();
    });

    it.each(['report.csv', 'über file (1).csv'])(
      'round-trips %s through presigned PUT and GET on the public endpoint',
      async (name) => {
        const { storage, publicEndpoint } = current();
        const key = newKey(name);
        const content = 'a,b\n1,2\n';
        const upload = await storage.createPresignedUpload(key, {
          contentType: 'text/csv',
          expiresInSec: 60,
        });
        expect(upload.url.startsWith(`${publicEndpoint}/`)).toBe(true);
        const put = await fetch(upload.url, {
          method: 'PUT',
          headers: upload.headers,
          body: content,
        });
        expect(put.status, await put.text()).toBeLessThan(300);
        expect(await storage.head(key)).toMatchObject({ key, size: content.length });

        const download = await storage.createPresignedDownload(key, { expiresInSec: 60 });
        expect(download.url.startsWith(`${publicEndpoint}/`)).toBe(true);
        const get = await fetch(download.url);
        expect(get.status).toBe(200);
        expect(await get.text()).toBe(content);
      },
    );

    extra?.(current);
  });
}

driverContract(
  'S3StorageDriver (RustFS)',
  async () => {
    const emulator = await startRustfs();
    const cfg = storageConfig.parse({
      STORAGE_DRIVER: 's3',
      S3_ENDPOINT: emulator.internalEndpoint,
      S3_PUBLIC_ENDPOINT: emulator.publicEndpoint,
      S3_ACCESS_KEY_ID: EMULATOR_ACCESS_KEY,
      S3_SECRET_ACCESS_KEY: EMULATOR_SECRET_KEY,
      S3_BUCKET: EMULATOR_BUCKET,
    });
    const admin = createS3Client(cfg.s3);
    await admin.send(new CreateBucketCommand({ Bucket: EMULATOR_BUCKET }));
    admin.destroy();
    const storage = new S3StorageDriver(cfg);
    return {
      storage,
      publicEndpoint: emulator.publicEndpoint,
      close: async () => {
        storage.onModuleDestroy();
        await emulator.stop();
      },
    };
  },
  (current) => {
    it('rejects a presigned PUT whose body is larger than the signed content length', async () => {
      const { storage } = current();
      const key = newKey('pinned.txt');
      const upload = await storage.createPresignedUpload(key, {
        contentType: 'text/plain',
        contentLength: 4,
      });
      const tooBig = await fetch(upload.url, {
        method: 'PUT',
        headers: upload.headers,
        body: 'hello!',
      });
      expect(tooBig.ok).toBe(false);
      expect(await storage.head(key)).toBeNull();
      const exact = await fetch(upload.url, {
        method: 'PUT',
        headers: upload.headers,
        body: 'four',
      });
      expect(exact.ok, await exact.text()).toBe(true);
    });

    it('forces an attachment filename on a presigned download', async () => {
      const { storage } = current();
      const key = newKey('report.csv');
      await storage.upload({ key, body: Buffer.from('a,b\n'), contentType: 'text/csv' });
      const download = await storage.createPresignedDownload(key, { filename: 'Q3 report.csv' });
      const get = await fetch(download.url);
      expect(get.status).toBe(200);
      expect(get.headers.get('content-disposition')).toMatch(/^attachment;.*Q3/);
    });
  },
);

driverContract('GcsStorageDriver (fake-gcs-server)', async () => {
  const emulator = await startFakeGcs();
  const cfg = storageConfig.parse({
    STORAGE_DRIVER: 'gcs',
    GCS_API_ENDPOINT: emulator.internalEndpoint,
    GCS_PUBLIC_ENDPOINT: emulator.publicEndpoint,
    GCS_PROJECT_ID: EMULATOR_GCS_PROJECT,
    GCS_BUCKET: EMULATOR_BUCKET,
  });
  const client = createGcsClient(cfg.gcs);
  await client.createBucket(EMULATOR_BUCKET);
  return {
    storage: new GcsStorageDriver(cfg, client),
    publicEndpoint: emulator.publicEndpoint,
    close: () => emulator.stop(),
  };
});
