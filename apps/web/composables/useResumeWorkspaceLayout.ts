import { useState } from "#imports";

/**
 * @description 简历工作台"聚焦预览"布局状态，由页面与默认布局共享：
 * 页面在用户点击表单时进入聚焦模式，布局据此将侧边栏收缩为纯图标，
 * 工作台区域展开为「编辑表单 + 实时预览」左右分栏。
 */
export function useResumeWorkspaceLayout() {
  const formFocusActive = useState<boolean>(
    "resume-workspace-form-focus-active",
    () => false,
  );

  const enterFormFocus = () => {
    formFocusActive.value = true;
  };

  const exitFormFocus = () => {
    formFocusActive.value = false;
  };

  const toggleFormFocus = () => {
    formFocusActive.value = !formFocusActive.value;
  };

  return {
    formFocusActive,
    enterFormFocus,
    exitFormFocus,
    toggleFormFocus,
  };
}
