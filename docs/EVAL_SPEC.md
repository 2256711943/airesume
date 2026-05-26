# EVAL_SPEC.md

## 1. 评分目标

建立可解释的简历质量评分，辅助优化与版本选择。

## 2. 评分组成

- 规则评分（40%）
- LLM 评分（60%）

总分：`overall_score = rule_score * 0.4 + llm_score * 0.6`

## 3. 规则评分维度

- 结构完整性（摘要/经历/项目/技能）
- 关键词覆盖（岗位要求命中）
- 动词与结果表达（是否可量化）
- 信息一致性检查（时间、职责、技能不冲突）

## 4. LLM 评分维度（0-100）

- 岗位匹配度（role_fit）
- 清晰度（clarity）
- 结果导向（impact）
- 专业度（professionalism）
- 可读性（readability）

## 5. 改写触发规则

- 任一维度 < 60：触发定向改写建议
- overall_score < 70：建议重写
- overall_score >= 80：可优先推荐作为投递版本

## 6. 输出格式

```json
{
  "rule_score": 78,
  "llm_score": 74,
  "overall_score": 75.6,
  "dimensions": {
    "role_fit": 70,
    "clarity": 80,
    "impact": 65,
    "professionalism": 72,
    "readability": 83
  },
  "issues": ["impact_low"],
  "suggestions": ["补充可量化结果，例如效率提升或成本下降比例"]
}
```
