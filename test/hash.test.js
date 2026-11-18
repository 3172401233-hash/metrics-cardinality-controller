import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { fnv1a32, hashSample, stableBucket } from '../index.js';

describe('FNV-1a 32 位哈希', () => {
  it('匹配公开测试向量，保证跨进程稳定', () => {
    assert.equal(fnv1a32(''), 0x811c9dc5);
    assert.equal(fnv1a32('a'), 0xe40c292c);
    assert.equal(fnv1a32('foobar'), 0xbf9cf968);
  });

  it('同一输入永远得到同一哈希', () => {
    assert.equal(fnv1a32('request-id-abc'), fnv1a32('request-id-abc'));
  });
});

describe('stableBucket', () => {
  it('输出定宽、范围内的稳定 bucket 名', () => {
    const first = stableBucket('request-id-abc', 64);
    assert.match(first, /^bucket_\d{2}$/);
    assert.equal(first, stableBucket('request-id-abc', 64));

    for (let index = 0; index < 500; index += 1) {
      const bucket = stableBucket(`id-${index}`, 64);
      assert.match(bucket, /^bucket_([0-5]\d|6[0-3])$/);
    }
  });

  it('bucket 数量变化时宽度与范围随之变化', () => {
    assert.match(stableBucket('x', 8), /^bucket_[0-7]$/);
    assert.match(stableBucket('x', 256), /^bucket_\d{3}$/);
  });

  it('拒绝非法 bucketCount', () => {
    assert.throws(() => stableBucket('x', 0));
  });
});

describe('hashSample', () => {
  it('边界采样率行为确定', () => {
    assert.equal(hashSample('key-1', 1), true);
    assert.equal(hashSample('key-1', 0), false);
  });

  it('同一 key 的采样结论可重复', () => {
    for (let index = 0; index < 100; index += 1) {
      const key = `series-${index}`;
      assert.equal(hashSample(key, 0.5), hashSample(key, 0.5));
    }
  });

  it('采样率近似等于长期通过比例', () => {
    let admitted = 0;
    for (let index = 0; index < 10000; index += 1) {
      if (hashSample(`series-${index}`, 0.5)) {
        admitted += 1;
      }
    }
    assert.ok(admitted > 4000 && admitted < 6000, `实际通过数: ${admitted}`);
  });
});
