# AI_SPEC.md

## 1. 模型与参数（MVP）

- Provider: OpenAI API
- Temperature: 0.7
- Max tokens: 按模型默认上限并设置业务上限
- Timeout: 20s
- Retry: 最多 2 次（指数退避）

## 2. 任务类型

1. 简历生成（Primary）
2. 简历优化（Planned）
3. 简历评分（Planned）

## 3. 生成 Prompt 结构（抽象）

- System:
  - 角色：资深简历顾问 / 招聘评审
  - 约束：不得编造事实、不得夸大无法证明的结果
  - 输出：严格 JSON
- User:
  - 候选人基础信息（教育、工作、项目、技能）
  - 目标岗位信息（岗位名、职责、技能要求）
  - 输出语气与语言
  - 输出版本数

## 4. 结构化输出（示例）

```json
{
  "variants": [
    {
      "summary": "string",
      "experience": [
        {
          "company": "string",
          "role": "string",
          "highlights": ["string"]
        }
      ],
      "projects": [
        {
          "name": "string",
          "highlights": ["string"]
        }
      ],
      "skills": ["string"]
    }
  ]
}
```

## 5. 失败处理

- JSON 解析失败：触发一次“格式修复重试”
- 超时：返回 `LLM_TIMEOUT`
- 限流：返回 `RATE_LIMITED`
- 其他异常：返回 `INTERNAL_ERROR`

## 6. 质量底线

- 不得生成与用户输入不一致的履历事实
- 不得伪造学历、公司、职责、业绩数据
- 输出需结构完整，字段可解析，语言简洁专业
