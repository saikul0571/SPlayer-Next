<script setup lang="ts">
import { useWindowControls } from "@/composables/useWindowControls";
import { isMac } from "@/utils/config";
import IconMinus from "~icons/lucide/minus";
import IconSquare from "~icons/lucide/square";
import IconCopy from "~icons/lucide/copy";
import IconX from "~icons/lucide/x";

const props = defineProps<{
  /** 使用 cover 主题 */
  cover?: boolean;
  /** 直接退出 */
  directQuit?: boolean;
}>();

const { isMaximized, isBorderless, minimize, toggleMaximize, close, quit } = useWindowControls();

const onClose = (): void => {
  props.directQuit ? quit() : close();
};
</script>

<template>
  <!-- macOS 无边框模式使用系统原生红绿灯，不渲染自绘控制按钮 -->
  <div v-if="isBorderless && !isMac" class="flex items-center gap-3 shrink-0">
    <SButton
      class="window-control-button app-no-drag"
      :type="cover ? 'cover' : undefined"
      :variant="cover ? 'ghost' : 'tertiary'"
      circle
      :size="40"
      :icon-size="16"
      @click="minimize"
    >
      <template #icon><IconMinus /></template>
    </SButton>
    <SButton
      class="window-control-button app-no-drag"
      :type="cover ? 'cover' : undefined"
      :variant="cover ? 'ghost' : 'tertiary'"
      circle
      :size="40"
      :icon-size="16"
      @click="toggleMaximize"
    >
      <template #icon>
        <component :is="isMaximized ? IconCopy : IconSquare" />
      </template>
    </SButton>
    <SButton
      class="window-control-button window-control-button-close app-no-drag"
      :type="cover ? 'cover' : undefined"
      :variant="cover ? 'ghost' : 'tertiary'"
      circle
      :size="40"
      @click="onClose"
    >
      <template #icon><IconX /></template>
    </SButton>
  </div>
</template>

<style scoped>
.window-control-button {
  position: relative;
}

.window-control-button::before {
  content: "";
  position: absolute;
  inset: -12px -6px;
}

.window-control-button-close::before {
  right: -12px;
}
</style>
