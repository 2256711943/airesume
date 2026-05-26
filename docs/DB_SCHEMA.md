# DB_SCHEMA.md

## 1. 说明

- 当前应用接口只保留 `auth/*` 与 `resume/*`。
- 历史 `products/copy_*` 表已从应用层移除，不再作为业务模型维护目标。
- 以下为简历助手主链路的数据模型（当前 + 规划）。

## 2. users

- `id` (pk)
- `email` (unique)
- `password_hash`
- `name`
- `created_at`
- `updated_at`

## 3. resume_tasks（planned）

- `id` (pk)
- `user_id` (fk -> users.id)
- `status` (`pending|running|succeeded|failed`)
- `request_id` (unique)
- `model_name`
- `error_code` (nullable)
- `error_message` (nullable)
- `started_at` (nullable)
- `finished_at` (nullable)
- `created_at`

索引：

- `(user_id, created_at desc)`
- `(request_id)` unique

## 4. resume_versions（planned）

- `id` (pk)
- `task_id` (fk -> resume_tasks.id)
- `variant_index`
- `summary` (text)
- `experience` (jsonb)
- `projects` (jsonb)
- `skills` (jsonb)
- `source_type` (`generated|optimized`)
- `created_at`

索引：

- `(task_id, variant_index)`

