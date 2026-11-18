import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CardinalityController, canonicalKey } from '../index.js';

function buildController(ruleOverrides = {}) {
  const controller = new CardinalityController({ defaultBudget: 1000 });
  controller.configure('http_requests_total', {
    type: 'counter',
    budget: 5,
    labels: {
      requestId: { priority: 10, bucketCount: 8 },
      userInput: { priority: 20, bucketCount: 8 },
      route: { priority: 90, critical: true, bucketCount: 0 },
      status: { priority: 80, bucketCount: 0 },
    },
    ...ruleOverrides,
  });
  return controller;
}

describe('标签顺序与稳定 bucket', () => {
  it('label 顺序变化不会产生新序列', () => {
    const controller = buildController();
    const first = controller.observe('http_requests_total', {
      requestId: 'req-1',
      userInput: 'hello',
      route: '/api/login',
      status: '200',
    });
    const second = controller.observe('http_requests_total', {
      status: '200',
      route: '/api/login',
      userInput: 'hello',
      requestId: 'req-1',
    });
    assert.equal(first.seriesKey, second.seriesKey);
    assert.equal(controller.stats('http_requests_total').seriesCount, 1);
    assert.notEqual(first.seriesKey, canonicalKey({ requestId: 'req-1' }));
  });

  it('同一原始值在不同实例、不同时间落入同一 bucket', () => {
    const controllerA = buildController();
    const controllerB = buildController();
    const labels = {
      requestId: 'req-xyz',
      userInput: 'free-form text',
      route: '/api/search',
      status: '200',
    };
    const resultA = controllerA.observe('http_requests_total', labels);
    const resultB = controllerB.observe('http_requests_total', labels);
    assert.equal(resultA.seriesKey, resultB.seriesKey);
    assert.match(resultA.labels.requestId, /^bucket_/);
    assert.match(resultA.labels.userInput, /^bucket_/);
  });

  it('critical label 配置为可丢弃时直接报错', () => {
    const controller = new CardinalityController();
    assert.throws(() =>
      controller.configure('m', {
        labels: { route: { critical: true, bucketCount: 0 } },
        levels: [{ drop: ['route'] }],
      })
    );
  });
});

describe('预算逐步耗尽与聚合降级', () => {
  it('先 bucket，再逐级丢弃低优先级 label，critical label 保留', () => {
    const controller = buildController({
      labels: {
        requestId: { priority: 10, bucketCount: 32 },
        userInput: { priority: 20, bucketCount: 32 },
        route: { priority: 90, critical: true, bucketCount: 0 },
        status: { priority: 80, bucketCount: 0 },
      },
    });
    for (let index = 0; index < 40; index += 1) {
      controller.observe('http_requests_total', {
        requestId: `req-${index}`,
        userInput: `input-${index}`,
        route: '/api/login',
        status: '200',
      });
    }
    const stats = controller.stats('http_requests_total');
    assert.ok(stats.seriesCount <= 5);
    assert.equal(stats.budget, 5);
    assert.ok(stats.level >= 1);
    assert.equal(stats.rejected, 0);

    const degraded = controller.observe('http_requests_total', {
      requestId: 'req-999',
      userInput: 'input-999',
      route: '/api/login',
      status: '200',
    });
    assert.equal(degraded.admitted, true);
    assert.equal(degraded.metricName, 'http_requests_total');
    assert.equal(degraded.type, 'counter');
    assert.ok(degraded.degraded);
    assert.ok(!('requestId' in degraded.labels));
    assert.equal(degraded.labels.route, '/api/login');
    assert.equal(degraded.labels.status, '200');
  });

  it('最高聚合级仍超预算时拒绝新序列，且指标名与类型不变', () => {
    const controller = buildController({ budget: 2 });
    for (let index = 0; index < 40; index += 1) {
      controller.observe('http_requests_total', {
        requestId: `req-${index}`,
        userInput: `input-${index}`,
        route: `/route-${index % 6}`,
        status: String(200 + (index % 4)),
      });
    }
    const rejected = controller.observe('http_requests_total', {
      requestId: 'brand-new',
      userInput: 'never-seen',
      route: '/route-404',
      status: '599',
    });
    assert.equal(rejected.admitted, false);
    assert.equal(rejected.metricName, 'http_requests_total');
    assert.equal(rejected.type, 'counter');
    assert.ok(!('requestId' in rejected.labels));
    assert.ok(!('userInput' in rejected.labels));
    assert.equal(rejected.labels.route, '/route-404');
    assert.ok(controller.stats('http_requests_total').rejected >= 1);
  });

  it('显式聚合层级覆盖自动层级', () => {
    const controller = new CardinalityController();
    controller.configure('custom_metric', {
      type: 'gauge',
      budget: 2,
      labels: {
        low: { priority: 10, bucketCount: 0 },
        high: { priority: 90, critical: true, bucketCount: 0 },
      },
      levels: [{ drop: ['low'] }],
    });
    for (let index = 0; index < 5; index += 1) {
      controller.observe('custom_metric', {
        low: `v-${index}`,
        high: 'fixed',
      });
    }
    const stats = controller.stats('custom_metric');
    assert.ok(stats.seriesCount <= 2);
    assert.equal(stats.maxLevel, 1);
    const result = controller.observe('custom_metric', { low: 'x', high: 'fixed' });
    assert.equal(result.type, 'gauge');
    assert.deepEqual(result.labels, { high: 'fixed' });
  });
});

describe('相同序列重复出现', () => {
  it('重复观测复用序列并累计，不消耗预算', () => {
    const controller = buildController({ budget: 3 });
    for (let count = 0; count < 50; count += 1) {
      controller.observe('http_requests_total', {
        requestId: 'req-hot',
        userInput: 'same input',
        route: '/api/login',
        status: '200',
      });
    }
    const stats = controller.stats('http_requests_total');
    assert.equal(stats.seriesCount, 1);
    assert.equal(stats.totalObservations, 50);
    assert.equal(stats.level, 0);
    assert.equal(stats.rejected, 0);
  });
});

describe('热点标签', () => {
  it('top-K 热点值保留原始值，冷门值进入 bucket', () => {
    const controller = buildController();
    controller.updateRule('http_requests_total', {
      labels: { userInput: { hotLimit: 2, bucketCount: 8 } },
    });
    const makeLabels = (input) => ({
      requestId: `req-${input}`,
      userInput: input,
      route: '/api/search',
      status: '200',
    });
    for (let count = 0; count < 30; count += 1) {
      controller.observe('http_requests_total', makeLabels('hot-a'));
    }
    for (let count = 0; count < 20; count += 1) {
      controller.observe('http_requests_total', makeLabels('hot-b'));
    }
    const cold = controller.observe('http_requests_total', {
      requestId: 'req-cold',
      userInput: 'rare-input',
      route: '/api/search',
      status: '200',
    });
    const hot = controller.observe('http_requests_total', {
      requestId: 'req-cold-2',
      userInput: 'hot-a',
      route: '/api/search',
      status: '200',
    });
    assert.equal(hot.labels.userInput, 'hot-a');
    assert.match(cold.labels.userInput, /^bucket_/);
    assert.deepEqual(
      controller.stats('http_requests_total').hotLabels.userInput.sort(),
      ['hot-a', 'hot-b']
    );
  });

  it('窗口轮换后热点记忆保留，路由仍以原始值输出', () => {
    const controller = buildController();
    controller.updateRule('http_requests_total', {
      labels: { userInput: { hotLimit: 1, bucketCount: 8 } },
    });
    for (let count = 0; count < 10; count += 1) {
      controller.observe('http_requests_total', {
        requestId: `req-${count}`,
        userInput: 'kept-input',
        route: '/api/search',
        status: '200',
      });
    }
    controller.rotateWindow('http_requests_total');
    const after = controller.observe('http_requests_total', {
      requestId: 'req-new-window',
      userInput: 'new-window-input',
      route: '/api/search',
      status: '200',
    });
    assert.match(after.labels.userInput, /^bucket_/);
    assert.equal(after.labels.route, '/api/search');
    const kept = controller.observe('http_requests_total', {
      requestId: 'req-new-window-2',
      userInput: 'kept-input',
      route: '/api/search',
      status: '200',
    });
    assert.equal(kept.labels.userInput, 'kept-input');
    assert.equal(controller.stats('http_requests_total').seriesCount, 2);
    assert.deepEqual(controller.stats('http_requests_total').hotLabels.userInput, [
      'kept-input',
    ]);
  });
});

describe('规则更新', () => {
  it('收缩 budget 后重建序列，指标名与类型保持一致', () => {
    const controller = buildController({ budget: 8 });
    for (let index = 0; index < 8; index += 1) {
      controller.observe('http_requests_total', {
        requestId: `req-${index}`,
        userInput: `input-${index}`,
        route: '/api/login',
        status: '200',
      });
    }
    assert.equal(controller.stats('http_requests_total').seriesCount, 8);
    controller.updateRule('http_requests_total', { budget: 3 });
    const stats = controller.stats('http_requests_total');
    assert.equal(stats.budget, 3);
    assert.equal(stats.metricName, 'http_requests_total');
    assert.equal(stats.type, 'counter');
    assert.ok(stats.seriesCount <= 3);
    const result = controller.observe('http_requests_total', {
      requestId: 'req-0',
      userInput: 'input-0',
      route: '/api/login',
      status: '200',
    });
    assert.equal(result.metricName, 'http_requests_total');
    assert.equal(result.type, 'counter');
  });

  it('更新 label 规则后 bucket 映射随新规则变化且仍稳定', () => {
    const controller = buildController();
    const before = controller.observe('http_requests_total', {
      requestId: 'req-1',
      userInput: 'input-1',
      route: '/api/login',
      status: '200',
    });
    controller.updateRule('http_requests_total', {
      labels: { requestId: { bucketCount: 32 } },
    });
    const afterA = controller.observe('http_requests_total', {
      requestId: 'req-1',
      userInput: 'input-1',
      route: '/api/login',
      status: '200',
    });
    const afterB = controller.observe('http_requests_total', {
      requestId: 'req-1',
      userInput: 'input-1',
      route: '/api/login',
      status: '200',
    });
    assert.match(before.labels.requestId, /^bucket_/);
    assert.match(afterA.labels.requestId, /^bucket_\d{2}$/);
    assert.equal(afterA.seriesKey, afterB.seriesKey);
  });

  it('reset 清空窗口与热点记忆', () => {
    const controller = buildController();
    controller.observe('http_requests_total', {
      requestId: 'req-1',
      userInput: 'input-1',
      route: '/api/login',
      status: '200',
    });
    controller.reset('http_requests_total');
    const stats = controller.stats('http_requests_total');
    assert.equal(stats.seriesCount, 0);
    assert.equal(stats.totalObservations, 0);
    assert.deepEqual(stats.hotLabels.route, []);
  });
});

describe('确定性采样', () => {
  it('相同 label set 在不同实例上采样结论一致', () => {
    const controllerA = buildController({ budget: 1, sampleRate: 0.3 });
    const controllerB = buildController({ budget: 1, sampleRate: 0.3 });
    let admittedA = 0;
    let admittedB = 0;
    for (let index = 0; index < 40; index += 1) {
      const labels = {
        requestId: `req-${index}`,
        userInput: `input-${index}`,
        route: `/route-${index}`,
        status: String(200 + (index % 3)),
      };
      if (controllerA.observe('http_requests_total', labels).admitted) {
        admittedA += 1;
      }
      if (controllerB.observe('http_requests_total', labels).admitted) {
        admittedB += 1;
      }
    }
    assert.equal(admittedA, admittedB);
    assert.ok(controllerA.stats('http_requests_total').sampledOut > 0);
  });

  it('采样拒绝时指标名与类型仍然保持一致', () => {
    const controller = buildController({ budget: 1, sampleRate: 0 });
    controller.observe('http_requests_total', {
      requestId: 'req-first',
      userInput: 'input-first',
      route: '/a',
      status: '200',
    });
    const result = controller.observe('http_requests_total', {
      requestId: 'req-second',
      userInput: 'input-second',
      route: '/b',
      status: '201',
    });
    assert.equal(result.admitted, false);
    assert.equal(result.sampled, true);
    assert.equal(result.metricName, 'http_requests_total');
    assert.equal(result.type, 'counter');
  });
});
