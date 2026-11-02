<script setup lang="ts">
import { useSettingsStore } from "@/stores/settings";
import { isMac } from "@/utils/config";

defineProps<{
  collapsed: boolean;
}>();

const router = useRouter();
const settings = useSettingsStore();

/** macOS 无边框模式下原生红绿灯占据左上角，logo 整行下移避让 */
const trafficLightOffset = computed(() =>
  isMac && settings.system.system.borderlessWindow ? "mt-11" : "",
);

const goHome = (): void => {
  router.push("/");
};
</script>

<template>
  <div class="flex items-center justify-center h-16 shrink-0 px-4" :class="trafficLightOffset">
    <div
      role="link"
      tabindex="0"
      class="inline-flex items-center cursor-pointer transform-gpu transition-transform duration-300 hover:scale-105 active:scale-100"
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
