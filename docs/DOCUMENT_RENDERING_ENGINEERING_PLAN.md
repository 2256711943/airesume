# Document Rendering Engineering 执行计划

## 目标

把当前“生成内容后直接展示”的简历输出方式升级为 `Resume DSL + 模板渲染 + 稳定 PDF 导出` 的文档工程体系，保证预览与导出一致、模板可扩展、分页可控。

## 方案核心

- 简历内容层与模板展示层彻底解耦。
- 前端编辑和预览消费统一 `Resume DSL`，而不是直接拼 DOM。
- 文档渲染拆成 `内容建模 -> 模板映射 -> 布局计算 -> 预览/导出` 四段。
- 导出前做分页、字体、孤行寡行和溢出校验。
- 预览与 PDF 共享同一份布局规则，避免“页面好看但导出变形”。

## 数据模型

建议统一成以下文档对象：

- `resume_document`
- `resume_section`
- `template_schema`
- `layout_block`
- `render_job`

每份 `resume_document` 建议包含：

- `documentId`
- `version`
- `themeId`
- `locale`
- `meta`
- `sections`
- `updatedAt`

每个 `resume_section` 建议包含：

- `sectionId`
- `type`
- `order`
- `visible`
- `content`
- `styleTokens`

每个 `render_job` 建议包含：

- `jobId`
- `documentId`
- `templateId`
- `status`
- `pageCount`
- `warnings`
- `startedAt`
- `endedAt`

## 渲染流水线

- `Resume DSL` -> 生成结构化文档模型
- `Template Schema` -> 把文档模型映射为模板块
- `Layout Engine` -> 计算分页、块高度、换行和页内分布
- `Preview Renderer` -> 在前端生成可编辑预览
- `PDF Renderer` -> 复用布局结果导出 PDF

## 前端结构

- `useResumeDslStore`：维护文档模型、版本和 section 更新。
- `useTemplateRegistry`：注册模板、主题和样式 token。
- `useLayoutInspector`：展示分页结果、溢出告警和布局调试信息。
- `ResumePreviewCanvas`：统一预览入口。
- `TemplateSwitcherPanel`：切换模板并保留 DSL 内容不变。
- `ExportJobPanel`：跟踪导出任务、警告和最终产物。

## 文档校验

- 字段缺失校验：必填 section 不可空。
- 布局校验：页边距、分页断点、文本溢出。
- 视觉校验：字体加载失败、图标降级、主题缺失。
- 导出校验：预览页数与 PDF 页数一致，关键字段不丢失。

## 实施步骤

1. 定义 Resume DSL、模板 schema 和 render job 数据结构。
2. 把当前简历生成结果映射到 DSL，消除模板和内容的耦合。
3. 落地前端预览渲染器，先支持单模板稳定预览。
4. 增加布局计算与分页校验，产出可调试的 layout block。
5. 接入 PDF 导出链路，复用同一套布局结果。
6. 扩展模板切换、主题配置和导出任务追踪。
7. 清理直接基于页面样式截屏导出的旧方案。

## 验收标准

- 同一份 DSL 切换模板时，内容不丢失、结构不变。
- 预览与 PDF 在分页、字体和段落布局上保持一致。
- 导出前能识别溢出、孤行寡行和字段缺失等风险。
- 新增一个模板时，不需要改动核心业务数据结构。
- 长简历和多版本简历都能稳定导出并追踪 render job 状态。

## 风险与控制

- 不要一开始支持过多模板，先打透一套稳定链路。
- 布局引擎和样式主题必须分层，避免模板逻辑侵入内容模型。
- PDF 渲染环境和浏览器预览差异要通过统一字体和布局规则收敛。
- 导出失败要保留中间 render job 信息，便于定位问题。
