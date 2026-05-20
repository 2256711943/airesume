# EVAL_SPEC.md

## 1. 评分目标

建立可解释的文案质量评分，辅助改写与采纳决策。

## 2. 评分组成

- 规则评分（40%）
- LLM 评分（60%）

总分：`overall_score = rule_score * 0.4 + llm_score * 0.6`

## 3. 规则评分维度

- 长度合理性（标题/正文长度区间）
- 关键词覆盖（卖点命中）
- 禁用词检查
- CTA 存在性

## 4. LLM 评分维度（0-100）

- 吸引力（hook）
- 清晰度（clarity）
- 卖点具体性（specificity）
- 行动驱动（actionability）
- 平台适配度（platform_fit）

## 5. 改写触发规则

- 任一维度 < 60：触发定向改写建议
- overall_score < 70：建议重写
- overall_score >= 80：可优先推荐采纳

## 6. 输出格式

```json
{
  "rule_score": 78,
  "llm_score": 74,
  "overall_score": 75.6,
  "dimensions": {
    "hook": 70,
    "clarity": 80,
    "specificity": 65,
    "actionability": 72,
    "platform_fit": 83
  },
  "issues": ["specificity_low"],
  "suggestions": ["补充商品成分与使用场景"]
}
```

