# JD_LLM_IMPLEMENTATION_PLAN.md

## 1. 目标与范围

### 1.1 目标
- 用 LLM 主导 JD 结构化解析，替代大规模手工词典维护。
- 在跨行业场景下保持可扩展、可解释、可评估的解析质量。
- 通过“解析 -> 校验 -> 重写”闭环，提升最终简历生成贴合度。

### 1.2 非目标
- 不追求一次性替换全部规则。数值类字段保留轻规则兜底。
- 不在第一阶段引入复杂知识图谱或人工标注平台。

---

## 2. 方案总览

### 2.1 核心策略
- `LLM 结构化抽取`：主流程负责语义理解和字段抽取。
- `轻规则校正`：仅处理高确定性字段（年限、薪资、学历、地点）。
- `LLM Judge 重排`：对候选解析结果自动打分，选择最优结果。
- `失败字段定向重写`：只重写低分字段，减少整体抖动。

### 2.2 架构分层
1. **Input Layer**
   - 输入：岗位名、行业、年限（可选）、JD 原文。
2. **Parse Layer**
   - LLM 函数调用输出结构化 JSON（强 Schema）。
3. **Validation Layer**
   - Schema 校验、规则校正、一致性检查。
4. **Judge Layer**
   - LLM 评分：贴合度、资历匹配、可量化程度、空话率、夸大风险。
5. **Rewrite Layer**
   - 基于错误码和低分维度定向重写。
6. **Output Layer**
   - 输出最终结构化 JD，用于后续生成简历。

---

## 3. 结构化 Schema（解析输出）

建议字段（v1）：
- `basic`: `jobTitleRaw`, `jobTitleNorm`, `industry`, `city`, `educationMin`, `yearsExpMin`, `yearsExpMax`
- `responsibilities[]`: `text`, `action`, `object`, `scope`, `evidenceSpan`, `confidence`
- `requirements.must[]` / `requirements.preferred[]`: `text`, `type`, `evidenceSpan`, `confidence`
- `skills`: `hardSkills[]`, `softSkills[]`, `tools[]`, `certificates[]`
- `businessGoals[]`: `goalType`, `text`, `metricHint`, `evidenceSpan`, `confidence`
- `keywords[]`
- `seniorityLevel`
- `quality`: `parseVersion`, `missingFields[]`, `warnings[]`

关键约束：
- 所有语义字段尽量带 `evidenceSpan`。
- `confidence` 取值 `0~1`。
- 严格 JSON Schema，不允许额外字段。

---

## 4. 解析链路设计

### 4.1 主调用（LLM Parse）
1. 输入 JD 原文和固定 Schema。
2. 使用 function calling 或 response schema 强约束输出。
3. 返回候选 `N=3` 份解析（不同采样种子）。

### 4.2 轻规则校正（Deterministic）
- 仅校正：
  - 年限：`3-5年`、`5年以上`
  - 薪资：`30-45K`、`15薪`
  - 学历：`本科/硕士/博士`
  - 地点：城市和远程标签
- 冲突处理：
  - 数值类：规则优先
  - 语义类：LLM + evidence 优先

### 4.3 Judge 评分与重排
- 评分维度（0~100）：
  - `role_fit` 岗位职责贴合度
  - `industry_fit` 行业语境贴合度
  - `seniority_fit` 年限与职责层级一致性
  - `specificity` 动作-对象-场景完整度
  - `measurability` 指标可量化程度
  - `safety` 夸大/违规风险
- 选取综合得分最高候选。

### 4.4 自动重写
- 触发条件（任一）：
  - `overall_score < 75`
  - `seniority_fit < 70`
  - `industry_fit < 70`
  - `safety < 80`
- 重写策略：
  - 只重写失败字段（如 `businessGoals` 或 `responsibilities`）。
  - 最大重试 2 次，超限返回“可人工修订版本 + 风险提示”。

---

## 5. Prompt 与函数调用规范

### 5.1 Parse System Prompt 要点
- 角色：JD 解析器，不做创造性写作。
- 原则：仅基于输入文本推断，未知字段留空，不猜测。
- 要求：输出严格符合 JSON Schema。
- 证据：每个关键字段附 `evidenceSpan`。

### 5.2 Judge System Prompt 要点
- 角色：招聘评审官。
- 输入：候选解析结果 + 原始 JD + 目标岗位/行业/年限。
- 输出：结构化评分 JSON + `issues[]` + `rewriteHints[]`。

### 5.3 重写 Prompt 要点
- 输入：原候选 JSON + 失败维度 + rewrite hints。
- 限制：只改指定字段，其他字段保持不变。

---

## 6. 数据与检索增强（替代词典扩展）

### 6.1 动态术语来源
- 从历史 JD 自动抽取高频短语（n-gram + PMI/TF-IDF）。
- 按行业/岗位聚类，形成“弱词库”（自动更新，不手工维护）。

### 6.2 检索增强
- 检索输入：岗位 + 行业 + 年限。
- 召回内容：真实 JD 片段（职责、要求、指标表达）。
- 用法：作为 Parse/Judge 的参考上下文，降低通用话术。

### 6.3 更新策略
- 每周离线更新聚类短语和向量索引。
- 每次上线前固定评测集回归测试。

---

## 7. 评测与验收

### 7.1 离线评测集
- 每个重点行业至少 100 条 JD。
- 包含：互联网、金融、制造、零售、医疗、教育、运营、销售、职能。

### 7.2 核心指标
- `Field Accuracy`：关键字段抽取准确率
- `Industry Fit`：行业贴合评分
- `Seniority Mismatch Rate`：资历错配率
- `Template Rate`：空话模板占比
- `First-pass Yield`：一次通过率
- `Manual Approval Rate`：人工审核通过率

### 7.3 上线门槛（建议）
- 一次通过率 >= 80%
- 资历错配率 <= 8%
- 空话率 <= 12%
- 人审通过率 >= 85%

---

## 8. 分阶段实施计划

### Phase 1（1 周）
- 接入 Parse function calling（单候选）。
- 增加 Schema 校验和轻规则校正。
- 输出 `evidenceSpan` 与基础 `quality.warnings`。

### Phase 2（1~2 周）
- 增加多候选（N=3）+ Judge 重排。
- 新增重写链路（最多 2 次）。
- 打通指标埋点与日志面板。

### Phase 3（2 周）
- 接入检索增强（行业真实 JD 片段）。
- 上线动态术语离线更新任务。
- 完成跨行业评测并灰度发布。

### Phase 4（持续）
- 建立“失败案例库”与 prompt 版本化。
- 按行业持续优化 Judge 权重和重写策略。

---

## 9. 工程落地建议（结合当前项目）

### 9.1 后端模块建议
- `apps/api/src/resume/jd-parser/`
  - `jd-parser.service.ts`：编排 parse/judge/rewrite
  - `schema.ts`：parse/judge 输出 schema
  - `rules.ts`：轻规则校正
  - `metrics.ts`：埋点与质量统计

### 9.2 API 建议
- 已有：`POST /resume/jd/parse`
- 可扩展：
  - `POST /resume/jd/parse?debug=true` 返回候选评分和重写轨迹
  - `POST /resume/jd/evaluate` 用于离线评测工具链

### 9.3 日志与可观测
- 记录：模型版本、prompt 版本、tokens、耗时、重试次数、judge 分数。
- 按 requestId 贯穿 parse -> generate 全链路。

---

## 10. 风险与对策

1. **成本上升（多候选 + judge）**
- 对策：分层开关，默认单候选，低置信度时才触发扩展链路。

2. **时延上升**
- 对策：并行候选生成，设置总超时预算（如 8s/12s 分级）。

3. **幻觉与夸大**
- 对策：evidence 绑定 + safety 评分 + 定向重写。

4. **跨行业偏差**
- 对策：检索增强 + 行业评测集 + 周期性回归。

---

## 11. 验收清单（DoD）

- [ ] `POST /resume/jd/parse` 支持 Parse + 校正 + 质量输出
- [ ] 解析结果可返回 `evidenceSpan`
- [ ] Judge 评分链路可开关启用
- [ ] 重写链路可开关启用
- [ ] 指标埋点和基础报表可用
- [ ] 离线评测集可复现
- [ ] 灰度发布与回滚策略可执行

