import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyCors,
  createRateLimiter,
  getAllowedOrigins,
  validateVisionBody
} from '../api/security.js';

function createResponse() {
  const headers = new Map();
  return {
    headers,
    setHeader(name, value) {
      headers.set(name, value);
    }
  };
}

test('CORS only accepts configured origins', () => {
  const allowed = createResponse();
  const denied = createResponse();
  assert.equal(applyCors({ headers: { origin: 'https://lockmyitem.asia' } }, allowed, 'https://lockmyitem.asia'), true);
  assert.equal(allowed.headers.get('Access-Control-Allow-Origin'), 'https://lockmyitem.asia');
  assert.equal(applyCors({ headers: { origin: 'https://evil.example' } }, denied, 'https://lockmyitem.asia'), false);
  assert.deepEqual(getAllowedOrigins('https://a.example, https://b.example/'), ['https://a.example', 'https://b.example']);
});

test('vision validation enforces type, size and HTTPS URLs', () => {
  assert.equal(validateVisionBody({ imageBase64: 'abc', mimeType: 'image/gif' }).status, 415);
  assert.equal(validateVisionBody({ imageUrl: 'http://example.com/item.jpg' }).code, 'INVALID_IMAGE_URL');
  assert.equal(validateVisionBody({ imageUrl: 'https://example.com/item.jpg' }).ok, true);
});

test('rate limiter isolates clients', () => {
  const limiter = createRateLimiter({ limit: 1, windowMs: 1000 });
  assert.equal(limiter.check('ip-a', 0).allowed, true);
  assert.equal(limiter.check('ip-a', 1).allowed, false);
  assert.equal(limiter.check('ip-b', 1).allowed, true);
});
