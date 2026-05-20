# AI_SPEC.md

## 1. 模型与参数（MVP）

- Provider: OpenAI API
- Temperature: 0.7
- Max tokens: 按模型默认上限并设置业务上限
- Timeout: 20s
- Retry: 最多 2 次（指数退避）

## 2. 任务类型

1. 文案生成
2. 文案评分
3. 定向改写

## 3. 生成 Prompt 结构（抽象）

- System:
  - 角色：资深电商文案策划
  - 约束：不得虚假宣传，不得触发禁用词
  - 输出：严格 JSON
- User:
  - 商品信息
  - 目标人群
  - 平台与语气
  - 输出版本数

## 4. 结构化输出（示例）

```json
{
  "variants": [
    {
      "title": "string",
      "body": "string",
      "bullets": ["string"],
      "cta": "string"
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

- 不生成绝对化违禁表达（如“100%治愈”等）
- 不生成与输入商品无关内容
- 保持文案可读性与行动导向

