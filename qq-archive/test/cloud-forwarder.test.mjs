import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CloudForwarder, resolveArchiveFile } from '../src/cloud-forwarder.mjs';

test('cloud forwarder keeps a failed job and removes it after success', async () => {
  const archiveRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-forwarder-'));
  const imagePath = path.join(archiveRoot, 'archive-media', 'test.jpg');
  await fs.mkdir(path.dirname(imagePath), { recursive: true });
  await fs.writeFile(imagePath, Buffer.from('image'));
  let shouldFail = true;
  const calls = [];
  const forwarder = new CloudForwarder({
    archiveRoot,
    cloudIngestUrl: 'https://example.test/ingest',
    cloudIngestToken: 'secret',
    cloudGroupIds: new Set(['731332881']),
    cloudRetryMs: 60_000,
    cloudTimeoutMs: 1000,
    cloudMaxImageBytes: 1024
  }, {
    fetch: async (_url, options) => {
      calls.push(JSON.parse(options.body));
      return {
        ok: !shouldFail,
        status: shouldFail ? 503 : 200,
        json: async () => shouldFail ? ({ message: 'offline' }) : ({ ok: true, data: { status: 'pending' } })
      };
    }
  });

  await forwarder.init();
  await forwarder.enqueue({
    group_id: '731332881',
    message_id: '1',
    images: [{ relative_path: 'archive-media/test.jpg', original_file: 'test.jpg' }]
  });
  await forwarder.flush();
  assert.equal((await fs.readdir(forwarder.outboxDirectory)).length, 1);

  shouldFail = false;
  await forwarder.flush();
  assert.equal((await fs.readdir(forwarder.outboxDirectory)).length, 0);
  assert.equal(calls.at(-1).media[0].base64, Buffer.from('image').toString('base64'));
  forwarder.stop();
  await fs.rm(archiveRoot, { recursive: true, force: true });
});

test('archive path traversal is rejected', () => {
  assert.throws(() => resolveArchiveFile('C:/archive', '../secret.jpg'));
});
