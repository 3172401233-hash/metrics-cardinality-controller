import { hashSample, stableBucket, stringifyValue } from './hash.js';

function escapeLabelToken(value) {
  return stringifyValue(value).replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

/**
 * label 顺序无关的稳定标识：按 key 排序后拼接。
 * 同样的 label set 无论以何种对象顺序传入，都得到同一序列标识。
 */
export function canonicalKey(labels) {
  const keys = Object.keys(labels).sort();
  return keys
    .map((key) => `${escapeLabelToken(key)}=${escapeLabelToken(labels[key])}`)
    .join('\n');
}

function normalizeLabelRules(labelRules = {}) {
  const result = {};
  for (const [name, rule] of Object.entries(labelRules)) {
    result[name] = {
      name,
      priority: Number.isFinite(rule.priority) ? rule.priority : 50,
      critical: rule.critical === true,
      bucketCount: Number.isInteger(rule.bucketCount) ? rule.bucketCount : 64,
      hotLimit: Number.isInteger(rule.hotLimit) ? rule.hotLimit : 0,
    };
  }
  return result;
}

function validateAggregationLevels(levels, criticalNames) {
  if (!Array.isArray(levels)) {
    throw new Error('rule.levels 必须是数组');
  }
  for (const level of levels) {
    if (!Array.isArray(level.drop)) {
      throw new Error('每个聚合层级必须包含 drop 数组');
    }
    const touchedCritical = level.drop.filter((name) => criticalNames.has(name));
    if (touchedCritical.length > 0) {
      throw new Error(
        `critical label 不能被聚合丢弃: ${touchedCritical.join(', ')}`
      );
    }
  }
}

/**
 * 未显式配置聚合层级时，按 priority 升序自动生成：
 * 每一级丢弃一个非 critical label，最低价值的 label 最先被聚合。
 */
function buildAggregationLevels(labelRules) {
  const droppable = Object.values(labelRules)
    .filter((rule) => !rule.critical)
    .sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name))
    .map((rule) => rule.name);
  return droppable.map((name) => ({ drop: [name] }));
}

function normalizeRule(rule) {
  const labels = normalizeLabelRules(rule.labels);
  const criticalNames = new Set(
    Object.values(labels)
      .filter((label) => label.critical)
      .map((label) => label.name)
  );
  const autoLevels = buildAggregationLevels(labels);
  let levels = rule.levels ? rule.levels : autoLevels;
  validateAggregationLevels(levels, criticalNames);
  levels = levels.map((level) => ({ drop: [...level.drop] }));

  const budget = Number.isInteger(rule.budget) && rule.budget > 0 ? rule.budget : 1000;
  const sampleRate =
    Number.isFinite(rule.sampleRate) && rule.sampleRate >= 0 && rule.sampleRate <= 1
      ? rule.sampleRate
      : 1;

  return {
    type: rule.type || 'counter',
    budget,
    sampleRate,
    labels,
    levels,
  };
}

function createSeriesState() {
  return {
    series: new Map(),
    level: 0,
    totalObservations: 0,
    rejected: 0,
    sampledOut: 0,
  };
}

function createHotState(labels) {
  const state = {};
  for (const rule of Object.values(labels)) {
    state[rule.name] = { freq: new Map(), firstSeen: new Map(), hot: new Set() };
  }
  return state;
}

function mergeHotState(previous, labels) {
  const merged = { ...previous };
  for (const name of Object.keys(labels)) {
    if (!merged[name]) {
      merged[name] = { freq: new Map(), firstSeen: new Map(), hot: new Set() };
    }
  }
  for (const name of Object.keys(merged)) {
    if (!labels[name]) {
      delete merged[name];
    }
  }
  return merged;
}

export class CardinalityController {
  constructor(options = {}) {
    this.defaultBudget =
      Number.isInteger(options.defaultBudget) && options.defaultBudget > 0
        ? options.defaultBudget
        : 1000;
    this.metrics = new Map();
  }

 configure(metricName, rule = {}) {
    const normalized = normalizeRule({
      budget: this.defaultBudget,
      ...rule,
    });
    const previous = this.metrics.get(metricName);
    const hot = previous
      ? mergeHotState(previous.hot, normalized.labels)
      : createHotState(normalized.labels);
    this.metrics.set(metricName, {
      name: metricName,
      rule: normalized,
      ...createSeriesState(),
      hot,
    });
    if (previous) {
      this._rebuild(metricName, 0);
    }
    return this.getRule(metricName);
  }

  register(metricName, rule) {
    return this.configure(metricName, rule);
  }

  updateRule(metricName, patch) {
    const current = this._requireMetric(metricName);
    const mergedLabels = { ...current.rule.labels };
    if (patch.labels) {
      for (const [name, labelRule] of Object.entries(patch.labels)) {
        mergedLabels[name] = {
          ...(mergedLabels[name] || { priority: 50 }),
          ...labelRule,
          name,
        };
      }
    }
    const merged = {
      ...current.rule,
      ...patch,
      labels: mergedLabels,
    };
    delete merged.levels;
    if (patch.levels !== undefined) {
      merged.levels = patch.levels;
    }
    return this.configure(metricName, merged);
  }

  getRule(metricName) {
    const metric = this._requireMetric(metricName);
    return metric.rule;
  }

  _requireMetric(metricName) {
    const metric = this.metrics.get(metricName);
    if (!metric) {
      throw new Error(`未注册的 metric: ${metricName}`);
    }
    return metric;
  }

  _droppedAtLevel(metric, level) {
    const dropped = new Set();
    for (let index = 0; index < level && index < metric.rule.levels.length; index += 1) {
      for (const name of metric.rule.levels[index].drop) {
        dropped.add(name);
      }
    }
    return dropped;
  }

  /**
   * 把当前所有原始序列在 targetLevel 上重新投影。
   * targetLevel 全程保持不变：升级意味着整个指标统一用更粗的粒度，
   * 不允许旧序列退回低 level 重新占满预算。
   * 投影冲突的序列自动合并，观测值累加；预算仍装不下的序列被丢弃。
   */
  _rebuild(metricName, targetLevel) {
    const metric = this._requireMetric(metricName);
    const previousSeries = metric.series;
    const previousObservations = metric.totalObservations;
    const previousRejected = metric.rejected;
    const previousSampledOut = metric.sampledOut;
    metric.series = new Map();
    metric.level = targetLevel;
    metric.totalObservations = 0;
    metric.rejected = 0;
    metric.sampledOut = 0;

    for (const [, entry] of previousSeries) {
      const projected = this._project(metric, entry.rawLabels, targetLevel);
      const key = canonicalKey(projected.labels);
      const existing = metric.series.get(key);
      if (existing) {
        existing.observations += entry.observations;
      } else if (metric.series.size < metric.rule.budget) {
        metric.series.set(key, {
          rawKey: entry.rawKey,
          key,
          level: targetLevel,
          rawLabels: entry.rawLabels,
          labels: projected.labels,
          observations: entry.observations,
        });
      }
    }
    metric.totalObservations = previousObservations;
    metric.rejected = previousRejected;
    metric.sampledOut = previousSampledOut;
  }

  _findByRawKey(metric, rawKey) {
    for (const entry of metric.series.values()) {
      if (entry.rawKey === rawKey) {
        return entry;
      }
    }
    return null;
  }

  _createEntry(metric, rawLabels, level) {
    const projected = this._project(metric, rawLabels, level);
    const key = canonicalKey(projected.labels);
    if (metric.series.has(key)) {
      const existing = metric.series.get(key);
      existing.observations += 1;
      return existing;
    }
    const entry = {
      rawKey: canonicalKey(rawLabels),
      key,
      level,
      rawLabels: { ...rawLabels },
      labels: projected.labels,
      observations: 1,
    };
    metric.series.set(key, entry);
    return entry;
  }

  _recordHot(metric, labels) {
    for (const name of Object.keys(labels)) {
      const state = metric.hot[name];
      const labelRule = metric.rule.labels[name];
      if (!state || !labelRule || labelRule.hotLimit <= 0) {
        continue;
      }
      const value = stringifyValue(labels[name]);
      state.freq.set(value, (state.freq.get(value) || 0) + 1);
      if (!state.firstSeen.has(value)) {
        state.firstSeen.set(value, state.firstSeen.size);
      }
      if (state.hot.size < labelRule.hotLimit) {
        state.hot.add(value);
      } else if (state.hot.size === labelRule.hotLimit && labelRule.hotLimit > 0) {
        this._recomputeHot(state, labelRule.hotLimit);
      }
    }
  }

  _recomputeHot(state, hotLimit) {
    const ranked = [...state.freq.entries()].sort((a, b) => {
      if (b[1] !== a[1]) {
        return b[1] - a[1];
      }
      return state.firstSeen.get(a[0]) - state.firstSeen.get(b[0]);
    });
    state.hot = new Set(ranked.slice(0, hotLimit).map(([value]) => value));
  }

  _project(metric, rawLabels, level) {
    const dropped = this._droppedAtLevel(metric, level);
    const labels = {};
    const changes = [];

    for (const [name, rawValue] of Object.entries(rawLabels)) {
      if (dropped.has(name)) {
        changes.push({ label: name, action: 'dropped' });
        continue;
      }
      const labelRule = metric.rule.labels[name];
      const value = stringifyValue(rawValue);
      if (
        labelRule &&
        labelRule.bucketCount > 0 &&
        !(labelRule.hotLimit > 0 && metric.hot[name]?.hot.has(value))
      ) {
        labels[name] = stableBucket(value, labelRule.bucketCount);
        changes.push({ label: name, action: 'bucketed', bucket: labels[name] });
      } else {
        labels[name] = value;
      }
    }
    return { labels, changes };
  }

  observe(metricName, rawLabels = {}) {
    const metric = this._requireMetric(metricName);
    metric.totalObservations += 1;
    this._recordHot(metric, rawLabels);

    const rawKey = canonicalKey(rawLabels);
    const maxLevel = metric.rule.levels.length;

    const knownRaw = this._findByRawKey(metric, rawKey);
    if (knownRaw) {
      knownRaw.observations += 1;
      const projected = this._project(metric, rawLabels, knownRaw.level);
      return {
        admitted: true,
        metricName,
        type: metric.rule.type,
        labels: knownRaw.labels,
        seriesKey: knownRaw.key,
        level: knownRaw.level,
        degraded: knownRaw.level > 0 || projected.changes.length > 0,
        changes: projected.changes,
        sampled: false,
      };
    }

    if (!hashSample(rawKey, metric.rule.sampleRate)) {
      metric.sampledOut += 1;
      const projected = this._project(metric, rawLabels, maxLevel);
      return {
        admitted: false,
        metricName,
        type: metric.rule.type,
        labels: projected.labels,
        seriesKey: canonicalKey(projected.labels),
        level: maxLevel,
        degraded: true,
        changes: projected.changes,
        sampled: true,
      };
    }

    let admitted = null;
    if (metric.series.size < metric.rule.budget) {
      admitted = this._createEntry(metric, rawLabels, metric.level);
    }
    for (
      let nextLevel = metric.level + 1;
      !admitted && nextLevel <= maxLevel;
      nextLevel += 1
    ) {
      this._rebuild(metricName, nextLevel);
      admitted =
        this._findByRawKey(metric, rawKey) ||
        (metric.series.size < metric.rule.budget
          ? this._createEntry(metric, rawLabels, nextLevel)
          : null);
    }

    if (admitted) {
      const projected = this._project(metric, rawLabels, admitted.level);
      return {
        admitted: true,
        metricName,
        type: metric.rule.type,
        labels: admitted.labels,
        seriesKey: admitted.key,
        level: admitted.level,
        degraded: admitted.level > 0 || projected.changes.length > 0,
        changes: projected.changes,
        sampled: false,
      };
    }

    metric.rejected += 1;
    const fallback = this._project(metric, rawLabels, maxLevel);
    return {
      admitted: false,
      metricName,
      type: metric.rule.type,
      labels: fallback.labels,
      seriesKey: canonicalKey(fallback.labels),
      level: maxLevel,
      degraded: true,
      changes: fallback.changes,
      sampled: false,
    };
  }

  /**
   * 分钟窗口轮换：清空当前窗口序列，保留热点记忆与累计计数，
   * 聚合等级从 0 重新爬升，热点 label 因此可以继续保留原始值。
   */
  rotateWindow(metricName) {
    const metric = this._requireMetric(metricName);
    const summary = this.stats(metricName);
    metric.series = new Map();
    metric.level = 0;
    return summary;
  }

  reset(metricName) {
    if (metricName === undefined) {
      this.metrics.clear();
      return;
    }
    const metric = this._requireMetric(metricName);
    metric.series = new Map();
    metric.level = 0;
    metric.hot = createHotState(metric.rule.labels);
    metric.totalObservations = 0;
    metric.rejected = 0;
    metric.sampledOut = 0;
  }

  stats(metricName) {
    const metric = this._requireMetric(metricName);
    return {
      metricName,
      type: metric.rule.type,
      budget: metric.rule.budget,
      seriesCount: metric.series.size,
      level: metric.level,
      maxLevel: metric.rule.levels.length,
      totalObservations: metric.totalObservations,
      rejected: metric.rejected,
      sampledOut: metric.sampledOut,
      sampleRate: metric.rule.sampleRate,
      hotLabels: Object.fromEntries(
        Object.entries(metric.hot).map(([name, state]) => [name, [...state.hot]])
      ),
    };
  }
}
