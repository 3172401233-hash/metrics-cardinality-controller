# metrics-cardinality-controller

Node.js 指标基数控制器。当 `request_id`、用户输入等高基数 label 让单实例一分钟产生
几十万条时间序列时，它不丢弃数据，而是把高基数 label 映射为**稳定 bucket**，并在预算
耗尽时逐级聚合、确定性采样，保证仪表盘和告警指标连续不中断。

## 解决的问题

- 直接丢弃超限 label 会让仪表盘曲线和告警规则突然断裂。
- 直接保留原始值（请求 ID、自由文本输入）会让序列数随流量线性爆炸。
- 本控制器在**指标名与指标类型始终不变**的前提下，只改造 label 取值：
  原始值 → 定宽 bucket → 丢弃低价值 label → 确定性采样。

## 核心策略

### 1. 稳定哈希

`lib/hash.js` 使用 **FNV-1a 32 位**非加密哈希（见 `fnv1a32`）：

- 纯函数、无随机种子，同一字符串在任意进程、任意机器、任意时间结果一致；
- 32 位输出取模后映射到固定数量的桶，基数上限完全可控；
- 已用公开测试向量（`""`、`"a"`、`"foobar"`）锁定行为，升级依赖不会改变映射。

### 2. 稳定 bucket

`stableBucket(value, bucketCount)` 把任意 label 值映射为 `bucket_000` … `bucket_NNN`：

- 桶索引 = `fnv1a32(value) % bucketCount`，同一原始值永远落入同一桶，仪表盘曲线连续；
- 名称零填充，字典序与数值序一致，且始终是合法的 label 值；
- 基数从“无限”收敛为 `bucketCount`，例如 `bucketCount: 64` 时该 label 最多 64 个取值；
- `bucketCount: 0` 表示该 label 不做 bucket（通常用于 critical 或低基数字段）。

### 3. 保留优先级与聚合层级

每个 label 配置 `priority`（数值越大越重要）和可选 `critical: true`：

- `critical` label 在任何降级级别都不会被丢弃，配置错误时 `configure` 直接抛异常；
- 未显式配置 `levels` 时，控制器按 priority 升序自动生成聚合层级，最低价值 label 最先被丢弃；
- 也可以用 `levels: [{ drop: ['name'] }]` 显式声明聚合顺序。

预算（`budget`，单 metric 允许的最大活跃序列数）耗尽时，控制器升级一个聚合级别，
并把全部现存序列在新级别上**统一重新投影（rebuild）**，投影冲突的序列自动合并、观测值累加，
因此序列数只会下降不会反弹。最高聚合级别仍超预算时，新序列才会被拒绝。

### 4. 热点 label

对同时配置 `hotLimit` 与 `bucketCount` 的 label，控制器按出现频次维护 top-K 热点值：

- 热点值保留原始值（仪表盘上仍能看到 `/api/login` 这类关键路由）；
- 冷门值继续进入稳定 bucket；
- 频次相同时按首次出现顺序破并，结果确定；
- `rotateWindow` 分钟轮换只清空序列表、保留热点记忆，热点路由在下一分钟仍以原始值输出。

### 5. 确定性采样

最高聚合级别仍超预算时，对**新序列**做哈希采样（`sampleRate`，默认 `1` 即关闭）：

- 采样结论 = `fnv1a32("sampling:" + 原始序列标识) % 1000 < sampleRate * 1000`；
- 同一 label set 在不同实例、不同窗口的采样结论完全一致，不会因实例重启而抖动；
- 已存在序列的重复观测永远计入，采样只影响“是否准入新序列”；
- 长期通过比例近似等于采样率（测试中以 1 万条序列校验 0.5 采样率）。

## 降级一致性保证

`observe` 的每一种返回（正常、bucket、聚合、采样拒绝、预算拒绝）都携带：

- 不变的 `metricName` 与 `type`（counter / gauge / histogram 由注册规则决定）；
- 实际生效的 `labels`、`level`、`changes`（每个 label 是 `bucketed` 还是 `dropped`）；
- `admitted` / `sampled` / `degraded` 标志，便于接入方决定上报还是跳过。

因此导出端永远不需要改指标名或类型，仪表盘查询和告警规则不会失效。

## 用法

```js
import { CardinalityController } from 'metrics-cardinality-controller';

const controller = new CardinalityController({ defaultBudget: 1000 });

controller.configure('http_requests_total', {
  type: 'counter',
  budget: 500,
  sampleRate: 1,
  labels: {
    requestId: { priority: 10, bucketCount: 64 },
    userInput: { priority: 20, bucketCount: 64 },
    status:    { priority: 80, bucketCount: 0 },
    route:     { priority: 90, critical: true, bucketCount: 0, hotLimit: 10 },
  },
});

const result = controller.observe('http_requests_total', {
  requestId: 'req-8f3a21',
  userInput: 'free form text',
  status: '200',
  route: '/api/login',
});
// result.labels.requestId / userInput 形如 bucket_037
// route 命中热点时保留 "/api/login"
```

### 运行期规则更新与窗口轮换

```js
controller.updateRule('http_requests_total', { budget: 200 });
controller.updateRule('http_requests_total', {
  labels: { requestId: { bucketCount: 32 } },
});

// 每分钟调用：清空序列表，聚合等级归零，热点记忆保留
controller.rotateWindow('http_requests_total');

// 完全重置（含热点与计数）
controller.reset('http_requests_total');
```

label 的传入顺序不影响序列归属：内部按 key 排序生成 canonical key，
`{ a: '1', b: '2' }` 与 `{ b: '2', a: '1' }` 是同一条序列。

## API

- `new CardinalityController({ defaultBudget })`
- `configure(metricName, rule)` / `register(metricName, rule)`：注册或整体更新规则，现存序列自动重建
- `updateRule(metricName, patch)`：合并式更新预算、采样率或单个 label 规则
- `observe(metricName, labels)`：观测一次，返回准入结果与生效 label
- `rotateWindow(metricName)`：分钟窗口轮换，保留热点记忆
- `reset(metricName?)`：重置单 metric 或全部状态
- `stats(metricName)`：预算、序列数、聚合级别、拒绝/采样计数、热点值

## 测试

```bash
node --test
```

覆盖：FNV 测试向量与 bucket 稳定性、热点 top-K、预算逐步耗尽与逐级聚合、
相同序列重复出现、规则热更新、label 顺序变化、跨实例采样确定性、
以及降级后指标名与类型一致性。
