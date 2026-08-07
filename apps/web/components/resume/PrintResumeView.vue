<script setup lang="ts">
/**
 * @description 打印简历专用视图，输出可直接序列化为 outerHTML 的独立 DOM。
 */
import { computed, ref } from "vue";

import { RESUME_PRINT_STYLE_CLASS } from "../../utils/resume-print-style";
import type { ResumeVariant } from "../../utils/resume";

interface PrintEntryViewModel {
  title: string;
  meta: string;
  bullets: string[];
  isEmpty: boolean;
}

interface PrintResumeViewProps {
  fullName: string;
  targetRole: string;
  variant: ResumeVariant | null;
  pageNumber?: string;
  showPageFooter?: boolean;
}

const props = withDefaults(defineProps<PrintResumeViewProps>(), {
  pageNumber: "第 1 页 / 共 1 页",
  showPageFooter: true,
});

const rootElementRef = ref<HTMLElement | null>(null);
const classes = RESUME_PRINT_STYLE_CLASS;

const fullNameText = computed(() => props.fullName.trim() || "姓名待填写");
const targetRoleText = computed(
  () => props.targetRole.trim() || "目标岗位待填写",
);
const summaryText = computed(
  () => props.variant?.summary.trim() || "暂无个人总结",
);

const experienceItems = computed<PrintEntryViewModel[]>(() => {
  const experience = props.variant?.experience ?? [];
  if (experience.length === 0) {
    return [
      {
        title: "暂无工作经历",
        meta: "等待补充工作经历",
        bullets: ["这里会展示每段工作经历的关键亮点。"],
        isEmpty: true,
      },
    ];
  }

  return experience.map((item) => {
    const bullets = item.highlights
      .map((highlight) => highlight.trim())
      .filter((highlight) => highlight.length > 0);
    return {
      title: item.company.trim() || "未填写公司名称",
      meta: item.role.trim() || "未填写岗位名称",
      bullets: bullets.length > 0 ? bullets : ["暂无亮点描述"],
      isEmpty: false,
    };
  });
});

const projectItems = computed<PrintEntryViewModel[]>(() => {
  const projects = props.variant?.projects ?? [];
  if (projects.length === 0) {
    return [
      {
        title: "暂无项目经历",
        meta: "等待补充项目经历",
        bullets: ["这里会展示项目成果和职责亮点。"],
        isEmpty: true,
      },
    ];
  }

  return projects.map((item) => {
    const bullets = item.highlights
      .map((highlight) => highlight.trim())
      .filter((highlight) => highlight.length > 0);
    return {
      title: item.name.trim() || "未填写项目名称",
      meta: "",
      bullets: bullets.length > 0 ? bullets : ["暂无亮点描述"],
      isEmpty: false,
    };
  });
});

const skillTags = computed(() => {
  const skills =
    props.variant?.skills
      .map((skill) => skill.trim())
      .filter((skill) => skill.length > 0) ?? [];
  return skills.length > 0 ? skills : ["暂无核心技能"];
});

/**
 * @returns 当前打印视图根节点，供页面层读取 outerHTML。
 */
function getRootElement(): HTMLElement | null {
  return rootElementRef.value;
}

defineExpose({
  getRootElement,
  rootElementRef,
});
</script>

<template>
  <article ref="rootElementRef" :class="classes.root">
    <section :class="classes.page">
      <header :class="classes.header">
        <div>
          <h1 :class="classes.headerName">
            {{ fullNameText }}
          </h1>
          <p :class="classes.headerRole">
            {{ targetRoleText }}
          </p>
        </div>
      </header>

      <section :class="classes.section">
        <h2 :class="classes.sectionTitle">个人总结</h2>
        <p
          :class="[classes.summaryText, { [classes.muted]: !variant?.summary }]"
        >
          {{ summaryText }}
        </p>
      </section>

      <section :class="classes.section">
        <h2 :class="classes.sectionTitle">工作经历</h2>
        <div :class="classes.list">
          <article
            v-for="item in experienceItems"
            :key="`${item.title}-${item.meta}`"
            :class="[classes.entry, { [classes.avoidBreak]: !item.isEmpty }]"
          >
            <div>
              <div :class="classes.entryTitle">
                {{ item.title }}
              </div>
              <div
                v-if="item.meta"
                :class="[classes.entryMeta, { [classes.muted]: item.isEmpty }]"
              >
                {{ item.meta }}
              </div>
            </div>

            <ul :class="classes.list">
              <li
                v-for="bullet in item.bullets"
                :key="bullet"
                :class="classes.listItem"
              >
                {{ bullet }}
              </li>
            </ul>
          </article>
        </div>
      </section>

      <section :class="classes.section">
        <h2 :class="classes.sectionTitle">项目经历</h2>
        <div :class="classes.list">
          <article
            v-for="item in projectItems"
            :key="item.title"
            :class="[classes.entry, { [classes.avoidBreak]: !item.isEmpty }]"
          >
            <div>
              <div :class="classes.entryTitle">
                {{ item.title }}
              </div>
              <div
                v-if="item.meta"
                :class="[classes.entryMeta, { [classes.muted]: item.isEmpty }]"
              >
                {{ item.meta }}
              </div>
            </div>

            <ul :class="classes.list">
              <li
                v-for="bullet in item.bullets"
                :key="bullet"
                :class="classes.listItem"
              >
                {{ bullet }}
              </li>
            </ul>
          </article>
        </div>
      </section>

      <section :class="classes.section">
        <h2 :class="classes.sectionTitle">核心技能</h2>
        <div :class="classes.tagList">
          <span v-for="skill in skillTags" :key="skill" :class="classes.tag">
            {{ skill }}
          </span>
        </div>
      </section>

      <footer v-if="showPageFooter" :class="classes.footer">
        <span :class="classes.sectionHint"> 页码占位 </span>
        <span :class="classes.pageNumber">
          {{ pageNumber }}
        </span>
      </footer>
    </section>
  </article>
</template>
