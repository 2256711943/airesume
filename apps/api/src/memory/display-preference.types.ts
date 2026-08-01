/**
 * 当前单会话 MVP 支持的显示偏好分类。
 */
export const DISPLAY_PREFERENCE_CATEGORIES = [
  'language',
  'tone',
  'length',
  'format',
  'structure',
  'example_style',
  'output_order',
] as const;

export type DisplayPreferenceCategory =
  (typeof DISPLAY_PREFERENCE_CATEGORIES)[number];

/**
 * 显式显示偏好的来源类型。
 */
export const DISPLAY_PREFERENCE_SOURCE_KINDS = [
  'user_text',
  'ui_toggle',
  'manual_override',
] as const;

export type DisplayPreferenceSourceKind =
  (typeof DISPLAY_PREFERENCE_SOURCE_KINDS)[number];

/**
 * sourceRefs.kind 的受控取值，保证来源追溯一致。
 */
export const DISPLAY_PREFERENCE_SOURCE_REF_KINDS = [
  'conversation_message',
  'preference_ui_event',
  'preference_override_event',
] as const;

export type DisplayPreferenceSourceRefKind =
  (typeof DISPLAY_PREFERENCE_SOURCE_REF_KINDS)[number];

/**
 * 每个偏好分类允许使用的 key。
 */
export const DISPLAY_PREFERENCE_KEYS = {
  language: ['response_language'],
  tone: ['response_tone'],
  length: ['response_length'],
  format: ['output_format', 'markdown_preference'],
  structure: ['response_structure', 'section_policy'],
  example_style: ['example_policy', 'code_example_policy'],
  output_order: ['content_order'],
} as const satisfies Record<DisplayPreferenceCategory, readonly string[]>;

export type DisplayPreferenceKey = {
  [Category in DisplayPreferenceCategory]:
    (typeof DISPLAY_PREFERENCE_KEYS)[Category][number];
}[DisplayPreferenceCategory];

/**
 * 各 key 允许的归一化 value。
 */
export const DISPLAY_PREFERENCE_VALUES = {
  response_language: ['zh-CN', 'en-US', 'bilingual'],
  response_tone: ['professional', 'friendly', 'direct', 'formal', 'concise'],
  response_length: ['short', 'medium', 'long'],
  output_format: [
    'plain_text',
    'markdown',
    'table',
    'bullet_list',
    'numbered_list',
  ],
  markdown_preference: ['plain_text', 'markdown'],
  response_structure: [
    'answer_first',
    'summary_then_detail',
    'steps_first',
    'sections_required',
  ],
  section_policy: [
    'answer_first',
    'summary_then_detail',
    'steps_first',
    'sections_required',
  ],
  example_policy: ['with_examples', 'without_examples', 'minimal_examples'],
  code_example_policy: ['with_code', 'without_code'],
  content_order: [
    'issues_then_fix',
    'plan_then_details',
    'result_then_reason',
    'code_then_explanation',
  ],
} as const satisfies Record<DisplayPreferenceKey, readonly string[]>;

export type DisplayPreferenceValue<Key extends DisplayPreferenceKey> =
  (typeof DISPLAY_PREFERENCE_VALUES)[Key][number];

/**
 * key 与 category 的反向映射，供类型收窄与后续解析使用。
 */
export const DISPLAY_PREFERENCE_KEY_TO_CATEGORY = {
  response_language: 'language',
  response_tone: 'tone',
  response_length: 'length',
  output_format: 'format',
  markdown_preference: 'format',
  response_structure: 'structure',
  section_policy: 'structure',
  example_policy: 'example_style',
  code_example_policy: 'example_style',
  content_order: 'output_order',
} as const satisfies Record<DisplayPreferenceKey, DisplayPreferenceCategory>;

export type DisplayPreferenceCategoryByKey<Key extends DisplayPreferenceKey> =
  (typeof DISPLAY_PREFERENCE_KEY_TO_CATEGORY)[Key];

/**
 * 显示偏好在 memory 中统一使用 summarize 合并策略。
 */
export type DisplayPreferenceMergeStrategy = 'summarize';

/**
 * 显示偏好的 mergeGroup 命名规范。
 */
export type DisplayPreferenceMergeGroup =
  `display_preference:${DisplayPreferenceKey}`;

/**
 * 显示偏好来源引用。
 */
export interface DisplayPreferenceSourceRef {
  kind: DisplayPreferenceSourceRefKind;
  sourceId: string;
  fragment?: string | null;
  title?: string | null;
  metadata?: Record<string, string | number | boolean | null> | null;
}

/**
 * 原始候选偏好，尚未进入 memory 写入层。
 */
export interface DisplayPreferenceCandidate<
  Key extends DisplayPreferenceKey = DisplayPreferenceKey,
> {
  category: DisplayPreferenceCategoryByKey<Key>;
  key: Key;
  value: DisplayPreferenceValue<Key>;
  sourceKind: DisplayPreferenceSourceKind;
  sourceRef: DisplayPreferenceSourceRef;
  rawContent: string;
}

/**
 * preference memory.metadata 的结构约定。
 */
export interface DisplayPreferenceMemoryMetadata<
  Key extends DisplayPreferenceKey = DisplayPreferenceKey,
> extends Record<string, unknown> {
  category: DisplayPreferenceCategoryByKey<Key>;
  key: Key;
  normalizedValue: DisplayPreferenceValue<Key>;
  sourceKind: DisplayPreferenceSourceKind;
  sourceRefKind: DisplayPreferenceSourceRefKind;
  mergeGroup: DisplayPreferenceMergeGroup;
  mergeStrategy: DisplayPreferenceMergeStrategy;
}

/**
 * 判断给定字符串是否为合法显示偏好分类。
 *
 * @param value 待判断的分类字符串
 * @returns 若属于受控分类则返回 true
 */
export function isDisplayPreferenceCategory(
  value: string,
): value is DisplayPreferenceCategory {
  return DISPLAY_PREFERENCE_CATEGORIES.includes(
    value as DisplayPreferenceCategory,
  );
}

/**
 * 判断给定字符串是否为合法显示偏好来源类型。
 *
 * @param value 待判断的来源类型
 * @returns 若属于受控来源则返回 true
 */
export function isDisplayPreferenceSourceKind(
  value: string,
): value is DisplayPreferenceSourceKind {
  return DISPLAY_PREFERENCE_SOURCE_KINDS.includes(
    value as DisplayPreferenceSourceKind,
  );
}

/**
 * 判断给定字符串是否为合法显示偏好 key。
 *
 * @param value 待判断的偏好 key
 * @returns 若属于受控 key 则返回 true
 */
export function isDisplayPreferenceKey(
  value: string,
): value is DisplayPreferenceKey {
  return value in DISPLAY_PREFERENCE_KEY_TO_CATEGORY;
}

/**
 * 解析偏好 key 对应的分类。
 *
 * @param key 已通过校验的偏好 key
 * @returns 该 key 所属的偏好分类
 */
export function getDisplayPreferenceCategoryByKey<Key extends DisplayPreferenceKey>(
  key: Key,
): DisplayPreferenceCategoryByKey<Key> {
  return DISPLAY_PREFERENCE_KEY_TO_CATEGORY[key];
}

/**
 * 判断 value 是否属于指定 key 的受控归一化值。
 *
 * @param key 偏好 key
 * @param value 待判断的归一化值
 * @returns 若 value 对应 key 合法则返回 true
 */
export function isDisplayPreferenceValue<Key extends DisplayPreferenceKey>(
  key: Key,
  value: string,
): value is DisplayPreferenceValue<Key> {
  return (DISPLAY_PREFERENCE_VALUES[key] as readonly string[]).includes(value);
}

/**
 * 生成显示偏好专用 mergeGroup。
 *
 * @param key 偏好 key
 * @returns 供 memory.write 使用的 mergeGroup
 */
export function getDisplayPreferenceMergeGroup<Key extends DisplayPreferenceKey>(
  key: Key,
): DisplayPreferenceMergeGroup {
  return `display_preference:${key}`;
}
