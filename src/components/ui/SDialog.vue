<script setup lang="ts">
import type { CSSProperties } from "vue";
import { usePopupZIndex } from "@/composables/useZIndex";
import { isMac } from "@/utils/config";
import { useSettingsStore } from "@/stores/settings";

export interface SDialogProps {
  /** 控制打开状态（v-model:open） */
  open?: boolean;
  /** 是否为模态（阻止外部交互） */
  modal?: boolean;
  /** 标题（无障碍必需，不传则隐藏标题区） */
  title?: string;
  /** 描述文本 */
  description?: string;
  /** 是否显示关闭按钮 */
  closable?: boolean;
  /** 封面主题模式（播放器内使用） */
  cover?: boolean;
  /** 宽度，支持 CSS 值（默认 460px） */
  width?: string;
  /** 高度，支持 CSS 值（默认 auto，受 max-h 限制） */
  height?: string;
  /** 距视口顶部偏移 */
  top?: string;
  /** 内容区自定义样式 */
  contentStyle?: string | CSSProperties;
  /** 首次打开时再挂载内容 */
  lazy?: boolean;
  /** 关闭后销毁内容 */
  destroyOnClose?: boolean;
  /** 自定义固定层级 */
  zIndex?: number;
}

const props = withDefaults(defineProps<SDialogProps>(), {
  modal: true,
  closable: true,
  cover: false,
  width: "460px",
  height: "auto",
  lazy: true,
  destroyOnClose: false,
});

const DESTROY_DELAY_MS = 180;

const settings = useSettingsStore();

/** 红绿灯占据窗口左上角（约 74px 高度带），mac 无边框模式下弹窗需上下各留出安全区 */
const trafficSafeMaxHeight = computed(() =>
  isMac && settings.system.system.borderlessWindow ? "calc(100vh - 128px)" : undefined,
);

const containerStyle = computed(() => ({
  width: props.width,
  height: props.height === "auto" ? undefined : props.height,
  maxHeight: props.height === "auto" ? "85vh" : (trafficSafeMaxHeight.value ?? undefined),
  // 显式指定 top 时同样避让红绿灯（12vh 等在小窗口下可能进入红绿灯区域）
  top: props.top ? (trafficSafeMaxHeight.value ? `max(${props.top}, 72px)` : props.top) : undefined,
}));

const emit = defineEmits<{
  "update:open": [value: boolean];
}>();

const isOpen = ref(props.open ?? false);
const mounted = ref((!props.lazy && !props.destroyOnClose) || isOpen.value);
let destroyTimer: ReturnType<typeof setTimeout> | undefined;

const { zIndex: activeZIndex, onOpenChange } = usePopupZIndex(toRef(props, "zIndex"));

/** 更新内容挂载状态与动态层级 */
const syncMounted = (open: boolean): void => {
  if (destroyTimer) {
    clearTimeout(destroyTimer);
    destroyTimer = undefined;
  }

  onOpenChange(open);

  if (open) {
    mounted.value = true;
    return;
  }

  if (!props.destroyOnClose) return;

  destroyTimer = setTimeout(() => {
    mounted.value = false;
    destroyTimer = undefined;
  }, DESTROY_DELAY_MS);
};

watch(
  () => props.open,
  (val) => {
    if (val !== undefined) isOpen.value = val;
  },
);

watch(isOpen, syncMounted, { immediate: true });

onBeforeUnmount(() => {
  if (destroyTimer) clearTimeout(destroyTimer);
});

const setOpen = (val: boolean): void => {
  isOpen.value = val;
  emit("update:open", val);
};
</script>

<template>
  <DialogRoot :open="isOpen" :modal="modal" @update:open="setOpen">
    <!-- 触发器插槽 -->
    <DialogTrigger v-if="$slots.trigger" as-child>
      <slot name="trigger" />
    </DialogTrigger>

    <DialogPortal v-if="mounted">
      <!-- 遮罩层 -->
      <DialogOverlay
        :style="{ zIndex: activeZIndex }"
        :class="[
          'fixed inset-0 data-[state=open]:animate-overlay-in data-[state=closed]:animate-overlay-out',
          cover ? 'bg-black/50' : 'bg-black/40',
        ]"
      />
      <DialogContent
        :style="[containerStyle, { zIndex: activeZIndex }]"
        :class="[
          'fixed left-1/2 -translate-x-1/2',
          top ? '' : 'top-1/2 -translate-y-1/2',
          'rounded-xl shadow-xl overflow-hidden',
          'flex flex-col',
          top
            ? 'data-[state=open]:animate-dialog-in-top data-[state=closed]:animate-dialog-out-top'
            : 'data-[state=open]:animate-dialog-in data-[state=closed]:animate-dialog-out',
          'focus:outline-none',
          cover
            ? 'bg-black/55 backdrop-blur-xl backdrop-saturate-160 border border-solid border-white/10 text-cover'
            : 'bg-surface-alt border border-solid border-outline-variant/30 text-on-surface',
        ]"
      >
        <!-- 标题 + 描述 -->
        <div v-if="title" class="shrink-0 px-5 pt-4 pb-3 pr-12">
          <DialogTitle class="text-lg font-semibold">{{ title }}</DialogTitle>
          <DialogDescription
            v-if="description"
            :class="['text-xs mt-1', cover ? 'text-cover/50' : 'text-on-surface/50']"
          >
            {{ description }}
          </DialogDescription>
          <DialogDescription v-else class="sr-only">{{ title }}</DialogDescription>
        </div>
        <!-- 无障碍 -->
        <template v-else>
          <DialogTitle class="sr-only">Dialog</DialogTitle>
          <DialogDescription class="sr-only" />
        </template>
        <!-- 内容 -->
        <div
          class="flex-1 min-h-0 overflow-y-auto text-sm"
          :class="[
            height === 'auto' && 'px-5',
            height === 'auto' && !title && 'pt-4',
            height === 'auto' && !$slots.footer && 'pb-4',
          ]"
          :style="contentStyle"
        >
          <slot />
        </div>
        <!-- 底部操作 -->
        <div
          v-if="$slots.footer"
          class="shrink-0 px-5 pt-3 pb-4 flex items-center justify-end gap-2"
        >
          <slot name="footer" :close="() => setOpen(false)" />
        </div>
        <!-- 关闭按钮 -->
        <DialogClose v-if="closable" as-child>
          <SButton
            :type="cover ? 'cover' : 'default'"
            variant="ghost"
            size="small"
            circle
            class="absolute top-3 right-3"
          >
            <template #icon>
              <IconLucideX />
            </template>
          </SButton>
        </DialogClose>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
