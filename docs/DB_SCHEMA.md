# DB_SCHEMA.md

## 1. users

- `id` (pk)
- `email` (unique)
- `password_hash`
- `name`
- `created_at`
- `updated_at`

## 2. products

- `id` (pk)
- `user_id` (fk -> users.id)
- `name`
- `category`
- `selling_points` (jsonb)
- `target_audience`
- `platform`
- `tone`
- `banned_terms` (jsonb)
- `created_at`
- `updated_at`

索引：

- `(user_id, created_at desc)`
- `(platform, category)`

## 3. copy_tasks

- `id` (pk)
- `user_id` (fk)
- `product_id` (fk)
- `status` (`pending|running|succeeded|failed`)
- `request_id` (unique)
- `model_name`
- `error_code` (nullable)
- `error_message` (nullable)
- `started_at` (nullable)
- `finished_at` (nullable)
- `created_at`

## 4. copy_variants

- `id` (pk)
- `task_id` (fk)
- `variant_index`
- `title`
- `body`
- `bullets` (jsonb)
- `cta`
- `source_type` (`generated|rewritten`)
- `created_at`

索引：

- `(task_id, variant_index)`

## 5. copy_scores

- `id` (pk)
- `variant_id` (fk -> copy_variants.id)
- `rule_score`
- `llm_score`
- `overall_score`
- `dimensions` (jsonb)
- `created_at`

## 6. adoption_feedback

- `id` (pk)
- `variant_id` (fk)
- `user_id` (fk)
- `adopted` (boolean)
- `reason_tags` (jsonb)
- `comment` (nullable)
- `created_at`

