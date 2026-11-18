const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

export function stringifyValue(value) {
  if (value === null || value === undefined) {
    return String(value);
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}

/**
 * FNV-1a 32 位非加密哈希。
 * 纯函数、无随机种子：同一字符串在任意进程、任意机器上结果一致，
 * 因此同一原始 label 值永远落入同一个 bucket。
 */
export function fnv1a32(input) {
  const bytes = Buffer.from(String(input), 'utf8');
  let hash = FNV_OFFSET_BASIS;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash >>> 0;
}

/**
 * 把任意值映射到固定数量的稳定 bucket：bucket_000 ... bucket_049。
 * 桶索引由哈希取模得到，零填充宽度保证字典序与数值序一致，
 * 也让 Prometheus 等系统看到的 label 值始终合法、稳定。
 */
export function stableBucket(value, bucketCount) {
  if (!Number.isInteger(bucketCount) || bucketCount <= 0) {
    throw new Error(`bucketCount 必须是正整数，实际为: ${bucketCount}`);
  }
  const width = String(bucketCount - 1).length;
  const index = fnv1a32(stringifyValue(value)) % bucketCount;
  return `bucket_${String(index).padStart(width, '0')}`;
}

/**
 * 确定性采样：对同一 key 永远给出同一结论，与到达顺序、时间戳无关。
 * 采样率即长期通过比例，key 变化时结果近似均匀分布。
 */
export function hashSample(key, sampleRate) {
  if (sampleRate >= 1) {
    return true;
  }
  if (sampleRate <= 0) {
    return false;
  }
  const threshold = Math.floor(sampleRate * 1000);
  return fnv1a32(`sampling:${key}`) % 1000 < threshold;
}
