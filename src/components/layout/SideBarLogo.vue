<script setup lang="ts">
import { useSettingsStore } from "@/stores/settings";
import { isMac } from "@/utils/config";

defineProps<{
  collapsed: boolean;
}>();

const router = useRouter();
const settings = useSettingsStore();

/** macOS 无边框模式下原生红绿灯占据左上角，logo 整行下移避让。
 * 红绿灯底部约在窗口 y=36px：default/sidebar-full 布局侧栏从 y=0 开始需 mt-11（44px）；
 * floating 布局侧栏自带 mt-3（12px），补 mt-8（32px）使 logo 起始位置一致 */
const trafficLightOffset = computed(() => {
  if (!isMac || !settings.system.system.borderlessWindow) return "";
  return settings.appearance.layoutMode === "floating" ? "mt-8" : "mt-11";
});

/** macOS 无边框模式下 logo 行空白区域支持拖拽窗口 */
const isMacDraggable = computed(() => isMac && settings.system.system.borderlessWindow);

const goHome = (): void => {
  router.push("/");
};
</script>

<template>
  <div
    class="flex items-center justify-center h-16 shrink-0 px-4"
    :class="[trafficLightOffset, { 'app-drag-region': isMacDraggable }]"
  >
    <div
      role="link"
      tabindex="0"
      class="inline-flex items-center cursor-pointer app-no-drag transform-gpu transition-transform duration-300 hover:scale-105 active:scale-100"
      @click="goHome"
    >
      <SLogo :size="30" class="shrink-0" />
      <span
        class="text-[22px] text-primary mt-0.5 leading-10 overflow-hidden whitespace-nowrap font-logo transition-[width,opacity,margin] duration-300"
        :class="collapsed ? 'w-0 opacity-0 ml-0' : 'w-[90px] ml-2'"
      >
        SPlayer
      </span>
    </div>
  </div>
</template>
