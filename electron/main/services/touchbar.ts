/**
 * macOS TouchBar 播放器控件
 *
 * 窗口激活时，TouchBar 左侧显示：收藏 / 上一曲 / 播放暂停 / 下一曲 + 当前歌词行（无歌词时显示 歌曲名 - 歌手）。
 * 歌词使用 TouchBarLabel（无背景、进程内直改、零延迟）：整行歌词直接显示，超长行横向滚动。
 * 数据源：主进程 nowPlaying 服务（歌词、进度、播放状态、歌曲信息）；
 * 收藏状态由渲染进程经 IPC（player:syncLikeState）同步。
 * 控制按钮复用 player:event 派发，与系统托盘/系统媒体事件同一通道。
 *
 * 仅 macOS 生效；非 macOS 平台所有导出函数为空操作，不影响 Windows/Linux 构建。
 */

import { TouchBar, type BrowserWindow } from "electron";
import { sendToMain } from "@main/utils/broadcast";
import { playerLog } from "@main/utils/logger";
import {
  snapshot,
  onLyricChange,
  onPositionSync,
  onTrackChange,
} from "@main/services/nowPlaying";
import type { LyricLine } from "@shared/types/lyrics";

/** 是否 macOS（TouchBar 仅在此平台存在） */
const isMac = process.platform === "darwin";

/** 歌词可见窗口宽度上限（半角字符单位）：超宽文本截断加省略号。
 * 实测：TouchBar 渲染宽度上限介于 43 半角（301pt 正常）与 62 半角（434pt 空白）之间，
 * 再降一档到 44 单位（≈308pt）留安全余量 */
const LYRIC_LIMIT = 44;
/** 歌词提前显示时间（毫秒）：下一句歌词提前 0.5s 出现，与唱词同步 */
const LYRIC_LEAD_MS = 500;

/** 估算单字符显示宽度单位：非 ASCII（中文/蒙文/藏文等全角）记 2，半角记 1 */
const charUnit = (ch: string): number => (ch.codePointAt(0)! > 0x7f ? 2 : 1);

/** 统计文本显示宽度单位（全角=2/半角=1） */
const textUnits = (text: string): number => {
  let n = 0;
  for (const ch of text) n += charUnit(ch);
  return n;
};

/** 在满宽窗口（LYRIC_LIMIT 单位）内左右补半角空格，使文本居中 */
const centerText = (text: string, units: number): string => {
  const left = Math.floor((LYRIC_LIMIT - units) / 2);
  return " ".repeat(left) + text + " ".repeat(LYRIC_LIMIT - units - left);
};

/**
 * 歌词显示窗口：按显示宽度截断（保留省略号）+ 居中补空。
 * 全角文字（中文/蒙/藏）宽度约为半角两倍，若按字符数截断到 62 渲染宽度可达 ~868pt，
 * 超过 TouchBar 上限导致系统渲染空白；按宽度单位截断保证任何文字都不超宽。
 * @param text - 目标文本
 * @returns 可见窗口文本
 */
const lyricWindow = (text: string): string => {
  let limited = "";
  let units = 0;
  for (const ch of text) {
    const w = charUnit(ch);
    if (units + w > LYRIC_LIMIT - 2) {
      limited += "…"; // 省略号恒为 2 单位
      units += 2;
      break;
    }
    limited += ch;
    units += w;
  }
  return centerText(limited, units);
};

/** 按宽度单位从文本中截取一段窗口（起点 startUnits、宽 LYRIC_LIMIT 单位），不足补半角空格 */
const sliceByUnits = (text: string, startUnits: number): string => {
  // 定位起点字符索引
  let idx = 0;
  let units = 0;
  for (let i = 0; i < text.length; i++) {
    const w = charUnit(text[i]);
    if (units + w > startUnits) break;
    units += w;
    idx = i + 1;
  }
  // 从起点截取窗口
  let out = "";
  units = 0;
  for (let i = idx; i < text.length; i++) {
    const w = charUnit(text[i]);
    if (units + w > LYRIC_LIMIT) break;
    out += text[i];
    units += w;
  }
  return out + " ".repeat(LYRIC_LIMIT - units);
};

/**
 * 按播放进度滚动超长歌词：
 * 窗口位置 = 唱词进度 × 可滚动量——唱到行 50% 窗口滚到 50%，唱完行尾窗口才到行尾，
 * 不会出现「这句没唱完一半就滚到最后」。窗口宽度恒 ≤ LYRIC_LIMIT 单位（不超宽不空白）。
 * @param text - 整行歌词（含 ♪ 前缀）
 * @param totalUnits - 整行文本宽度单位（调用方已算好）
 * @param pos - 当前播放位置（毫秒）
 * @param lineStart - 当前行开始时间
 * @param lineEnd - 下一行开始时间（当前行结束）
 * @returns 可见窗口文本
 */
const lyricScroll = (
  text: string,
  totalUnits: number,
  pos: number,
  lineStart: number,
  lineEnd: number,
): string => {
  const maxStart = totalUnits - LYRIC_LIMIT;
  if (maxStart <= 0) return centerText(text, totalUnits);
  const lineDuration = Math.max(1200, lineEnd - lineStart);
  const rawProgress = Math.min(1, Math.max(0, (pos - lineStart) / lineDuration));
  // 滚动比唱词轻微提前（×1.15，更跟手），但唱到行尾仍封顶；
  // 末尾 5% 直接停靠行尾，完整显示最后内容（避免吞字）
  const progress = rawProgress >= 0.95 ? 1 : Math.min(1, rawProgress * 1.15);
  return sliceByUnits(text, progress * maxStart);
};

/** TouchBar 控件实例 */
let touchBar: TouchBar | null = null;
let favoriteBtn: Electron.TouchBarButton | null = null;
let playPauseBtn: Electron.TouchBarButton | null = null;
let prevBtn: Electron.TouchBarButton | null = null;
let nextBtn: Electron.TouchBarButton | null = null;
/** 歌词标签：整行歌词直接显示（超长行滚动），无逐字/变色 */
let lyricLabel: Electron.TouchBarLabel | null = null;
/** 主窗口引用（重建 TouchBar 时用于重新挂载） */
let mainWindow: BrowserWindow | null = null;

/** 已订阅的 nowPlaying 取消函数 */
let unsubscribers: Array<() => void> = [];
/** 是否已完成初始化（避免重复挂载） */
let initialized = false;

/** 定时重渲染句柄：保证歌词持续跟随播放位置（即使事件偶发延迟） */
let renderTimer: NodeJS.Timeout | null = null;
/** 上次调试日志时间（节流，避免刷屏） */
let lastDebugLogAt = 0;

/** 上次渲染的组合键（歌词文本），避免无变化时重复刷新 TouchBar */
let lastRenderedKey = "";
let lastRenderedPlaying: boolean | null = null;
/** 上次渲染的曲目 ID（切歌检测） */
let lastTrackId = "";
/** TouchBar 重建节流：高频重建（每次 setTouchBar）会导致系统渲染失效、歌词空白；
 * 平时只更新 label 文本，定期（REBUILD_INTERVAL 步）重建一次兜底防卡住 */
const REBUILD_INTERVAL = 4000; // 4000 步 × 1ms ≈ 4 秒
let rebuildTick = 0;

/** 平滑播放位置（毫秒）：本地连续外推 + 定期对齐原生推送。
 * 原生层约 700ms 才推送一次 position，若每次重算 elapsed 会导致位置锯齿跳动、滚动卡顿；
 * 用本地时钟 1ms 增量推进，2 秒对齐一次原生值防漂移，切歌/快进的大跳变立即对齐 */
let smoothPos = 0;
let lastRenderNow = Date.now();
let lastNativeSyncAt = 0;

/** 更新并返回平滑播放位置（每次渲染调用，即使歌词文本不变也要推进） */
const updateSmoothPos = (snap: ReturnType<typeof snapshot>): number => {
  const now = Date.now();
  if (snap.playing) {
    smoothPos += (now - lastRenderNow) * snap.speed;
    // 原生推送大跳变（切歌/快进/seek）立即对齐；平时每 2 秒对齐一次防漂移
    if (now - lastNativeSyncAt > 2000 || Math.abs(snap.position - smoothPos) > 2000) {
      smoothPos = snap.position;
      lastNativeSyncAt = now;
    }
  } else {
    smoothPos = snap.position;
    lastNativeSyncAt = now;
  }
  lastRenderNow = now;
  return smoothPos;
};

/**
 * 计算当前应展示的歌词文本
 *
 * 整行歌词直接显示（无逐字/变色）：跳过背景歌词（isBG），取“startTime 小于等于当前播放位置”
 * 的最后一行（无匹配回退首行）；超长行横向滚动显示完整内容；不附加翻译歌词。
 * 播放位置使用平滑推进的本地时钟（见 updateSmoothPos），不依赖原生推送频率。
 */
const computeDisplayText = (snap: ReturnType<typeof snapshot>): string | null => {
  const main = snap.lyric.filter((line) => !line.isBG);
  if (!main.length) return null;
  const pos = updateSmoothPos(snap) + LYRIC_LEAD_MS;
  let active: LyricLine | null = null;
  for (const line of main) {
    if (line.startTime <= pos) active = line;
    else break;
  }
  active ??= main[0];
  // 行尚未开始（如歌曲开头第一句之前）：无歌词可显示，交给调用方显示歌曲名
  if (pos < active.startTime) return null;
  const words = active.words ?? [];
  if (!words.length) return null;
  const full = `♪ ${words.map((w) => w.word).join("")}`;
  if (full.length <= 2) return null;
  // 超长行：按播放进度滚动（唱到哪滚到哪）；短行：居中显示
  const totalUnits = textUnits(full);
  if (totalUnits > LYRIC_LIMIT) {
    const lineIdx = main.indexOf(active);
    const lineEnd = main[lineIdx + 1]?.startTime ?? active.startTime + 6000;
    return lyricScroll(full, totalUnits, pos, active.startTime, lineEnd);
  }
  return lyricWindow(full);
};

/**
 * 重建 TouchBar。歌词文本变化后调用，强制系统重新渲染
 * （Electron TouchBarLabel 存在「值已变更但视觉不刷新/显示空白」的怪癖，
 * 重建 TouchBar 且重新创建 Label 实例可强制刷新——复用旧实例可能保留损坏的渲染状态）。
 */
const rebuildTouchBar = (): void => {
  if (!isMac) return;
  const { TouchBarLabel, TouchBarSpacer } = TouchBar;
  // 重新创建歌词标签实例（读取当前文本），替换旧实例
  const currentText = lyricLabel?.label ?? "♪ 等待播放";
  lyricLabel = new TouchBarLabel({ label: currentText, textColor: "#ffffff" });
  touchBar = new TouchBar({
    items: [
      favoriteBtn!,
      prevBtn!,
      playPauseBtn!,
      nextBtn!,
      // 左右弹性空白，让歌词块在剩余区域居中显示
      new TouchBarSpacer({ size: "flexible" }),
      lyricLabel,
      new TouchBarSpacer({ size: "flexible" }),
    ],
  });
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused()) {
    mainWindow.setTouchBar(touchBar);
  }
};

/** 渲染 TouchBar：更新播放按钮状态与中间歌词 */
const render = (): void => {
  if (!isMac || !touchBar) return;
  const snap = snapshot();
  const playing = snap.playing;

  // 切歌检测：曲目变化时立即对齐位置、强制重建并重渲染（避免旧歌词停留）
  const trackId = snap.track?.id ?? "";
  if (lastTrackId !== trackId) {
    lastTrackId = trackId;
    smoothPos = snap.position;
    lastNativeSyncAt = Date.now();
    lastRenderedKey = "";
    rebuildTick = 0;
    rebuildTouchBar();
    playerLog.info(`[touchbar] track-changed → id=${trackId} title=${snap.track?.title ?? ""} lyricLines=${snap.lyric.length}`);
  }

  // 播放/暂停按钮图标切换（仅在状态变化时刷新）
  if (playPauseBtn && lastRenderedPlaying !== playing) {
    playPauseBtn.label = playing ? ICON_PAUSE : ICON_PLAY;
    lastRenderedPlaying = playing;
  }

  // 中间歌词：整行直接显示（超长滚动，文本居中）；无歌词时显示 ♪ 歌曲名 - 歌手
  const lyric = computeDisplayText(snap);
  let key: string;
  let text: string;
  if (lyric) {
    text = lyric;
    key = `L|${lyric}`;
  } else if (snap.track) {
    const artist = snap.track.artists?.[0]?.name ?? "";
    const title = `♪ ${artist ? `${snap.track.title} - ${artist}` : snap.track.title}`;
    text = lyricWindow(title);
    key = `T|${text}`;
  } else {
    text = "♪ 等待播放";
    key = "E";
  }
  if (key !== lastRenderedKey) {
    lastRenderedKey = key;
    lyricLabel!.label = text;
    // 平时只更新 label 文本；定期重建一次兜底（防系统偶发不刷新）。
    // 不做每次重建——高频 setTouchBar 会导致系统渲染失效、歌词空白。
    rebuildTick++;
    if (rebuildTick >= REBUILD_INTERVAL) {
      rebuildTick = 0;
      rebuildTouchBar();
    }
  }

  // 节流调试日志：观察歌词是否卡住（位置是否推进、文本是否更新）
  const now = Date.now();
  if (now - lastDebugLogAt > 2000) {
    lastDebugLogAt = now;
    playerLog.info(
      `[touchbar] pos=${Math.round(smoothPos)} track=${snap.track?.title ?? "-"} ` +
        `lyricLines=${snap.lyric.length} text="${text}" playing=${playing}`,
    );
  }
};

/** 图标（原风格文本字符） */
const ICON_LIKE = "♡";
const ICON_LIKED = "♥";
const ICON_PREV = "⏮";
const ICON_PLAY = "▶";
const ICON_PAUSE = "⏸";
const ICON_NEXT = "⏭";

/** 构建 TouchBar 控件（仅 macOS） */
const buildTouchBar = (): void => {
  if (!isMac || touchBar) return;
  const { TouchBarButton, TouchBarLabel, TouchBarSpacer } = TouchBar;

  favoriteBtn = new TouchBarButton({
    label: ICON_LIKE,
    click: () => {
      sendToMain("player:event", { type: "toggleLike" });
    },
  });

  const prevButton = new TouchBarButton({
    label: ICON_PREV,
    click: () => {
      sendToMain("player:event", { type: "prev" });
    },
  });
  prevBtn = prevButton;

  playPauseBtn = new TouchBarButton({
    label: ICON_PLAY,
    click: () => {
      const isPlaying = snapshot().playing;
      sendToMain("player:event", { type: isPlaying ? "pause" : "play" });
    },
  });

  const nextButton = new TouchBarButton({
    label: ICON_NEXT,
    click: () => {
      sendToMain("player:event", { type: "next" });
    },
  });
  nextBtn = nextButton;

  lyricLabel = new TouchBarLabel({
    label: "♪ 等待播放",
    textColor: "#ffffff",
  });

  touchBar = new TouchBar({
    items: [
      favoriteBtn,
      prevBtn,
      playPauseBtn,
      nextBtn,
      // 左右弹性空白，让歌词块在剩余区域居中显示
      new TouchBarSpacer({ size: "flexible" }),
      lyricLabel,
      new TouchBarSpacer({ size: "flexible" }),
    ],
  });
};

/**
 * 初始化并挂载 TouchBar 到主窗口
 *
 * - 窗口聚焦时挂载播放器 TouchBar，失焦时移除恢复系统默认；
 * - 订阅 nowPlaying 状态事件，实时刷新歌词与播放状态。
 * @param win - 主窗口实例
 */
export const initTouchBar = (win: BrowserWindow): void => {
  if (!isMac || initialized) return;
  initialized = true;
  mainWindow = win;

  buildTouchBar();

  const attach = (): void => {
    if (!win.isDestroyed() && touchBar) win.setTouchBar(touchBar);
  };
  const detach = (): void => {
    if (!win.isDestroyed()) win.setTouchBar(null);
  };

  win.on("focus", attach);
  win.on("blur", detach);
  // 初始若已聚焦则立即挂载
  if (win.isFocused()) attach();

  // 订阅播放状态变化，刷新歌词与按钮；另加定时器兜底，保证歌词持续跟随位置
  unsubscribers = [
    onLyricChange(() => render()),
    onPositionSync(() => render()),
    onTrackChange(() => render()),
  ];
  render();
  // 1ms 轮询：进度滚动窗口最及时地跟随唱词推进（只更新 label 文本，不重建 TouchBar）
  renderTimer = setInterval(render, 1);
};

/**
 * 同步当前歌曲收藏状态到 TouchBar（由渲染进程经 IPC 调用）
 * @param liked - 是否已收藏
 */
export const setTouchBarLikeState = (liked: boolean): void => {
  if (!isMac || !favoriteBtn) return;
  favoriteBtn.label = liked ? ICON_LIKED : ICON_LIKE;
};

/** 销毁 TouchBar 与订阅（窗口关闭时调用） */
export const destroyTouchBar = (): void => {
  if (renderTimer) {
    clearInterval(renderTimer);
    renderTimer = null;
  }
  unsubscribers.forEach((unsub) => unsub());
  unsubscribers = [];
  touchBar = null;
  favoriteBtn = null;
  playPauseBtn = null;
  prevBtn = null;
  nextBtn = null;
  lyricLabel = null;
  mainWindow = null;
  initialized = false;
  lastRenderedKey = "";
  lastRenderedPlaying = null;
  lastTrackId = "";
  smoothPos = 0;
  lastRenderNow = Date.now();
  lastNativeSyncAt = 0;
  lastDebugLogAt = 0;
  rebuildTick = 0;
};
