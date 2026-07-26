const assert = require('node:assert/strict');
const test = require('node:test');
const {
  detectRiskFlags,
  normalizeIncomingRecord,
  parseCsv,
  reviewId,
  sanitizeDraft
} = require('./qq-review');

test('production group is the secure default', () => {
  assert.deepEqual([...parseCsv('')], ['731332881']);
});

test('review id is deterministic per group and message', () => {
  assert.equal(reviewId('731332881', '42'), reviewId('731332881', '42'));
  assert.notEqual(reviewId('731332881', '42'), reviewId('731332881', '43'));
});

test('incoming QQ message is normalized without retaining the raw QQ number', () => {
  const result = normalizeIncomingRecord({
    group_id: 731332881,
    message_id: 42,
    sender_id: 123456789,
    sender_name: '测试同学',
    content: '我在教学中心捡到一个黑色鼠标',
    lost_found: { type: 'found', confidence: 0.8 },
    images: []
  });
  assert.equal(result.groupId, '731332881');
  assert.equal(result.draft.category, '电子产品');
  assert.equal(result.draft.locationId, 'teaching');
  assert.equal(result.senderIdHash.length, 24);
  assert.equal(Object.hasOwn(result, 'senderId'), false);
});

test('PII and image risks are surfaced to the moderator', () => {
  assert.deepEqual(
    detectRiskFlags('手机号 13800138000', [{}]),
    ['IMAGE_REVIEW_REQUIRED', 'PHONE_NUMBER', 'POSSIBLE_PERSONAL_DATA']
  );
});

test('moderator draft is bounded and type constrained', () => {
  const draft = sanitizeDraft({
    type: 'invalid',
    title: 'a'.repeat(200),
    description: '说明',
    category: '电子产品',
    tags: ['鼠标', '鼠标']
  }, { type: 'lost' });
  assert.equal(draft.type, 'lost');
  assert.equal(draft.title.length, 80);
  assert.deepEqual(draft.tags, ['电子产品', '鼠标']);
});
