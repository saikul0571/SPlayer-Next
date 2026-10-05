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

/** 歌词可见窗口字符数，超出部分用滚动字幕完整显示 */
const LYRIC_LIMIT = 42;
/** 滚动字幕每步间隔（毫秒）：250ms 一步、每步 1 字符，接近平滑字幕效果 */
const MARQUEE_STEP_MS = 250;
/** 滚动字幕每步移动字符数 */
const MARQUEE_STEP_CHARS = 1;

/** 滚动字幕状态：当前滚动源文本与起始时间 */
let marqueeSource = "";
let marqueeStartedAt = 0;

/**
 * 超长文本滚动窗口：内容从左向右逐字滑出，循环完整显示。
 * @param text - 目标文本
 * @returns 可见窗口文本与窗口起始字符偏移（短文本返回 { text, 0 }）
 */
const marqueeWindow = (text: string): { window: string; start: number } => {
  if (text.length <= LYRIC_LIMIT) return { window: text, start: 0 };
  if (text !== marqueeSource) {
    marqueeSource = text;
    marqueeStartedAt = Date.now();
  }
  const step = Math.floor((Date.now() - marqueeStartedAt) / MARQUEE_STEP_MS);
  const start = (step * MARQUEE_STEP_CHARS) % (text.length + 1);
  return {
    window: text.slice(start, start + LYRIC_LIMIT).padEnd(LYRIC_LIMIT, " "),
    start,
  };
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

/**
 * 计算当前应展示的歌词文本
 *
 * 整行歌词直接显示（无逐字/变色）：跳过背景歌词（isBG），取“startTime 小于等于当前播放位置”
 * 的最后一行（无匹配回退首行）；超长行横向滚动显示完整内容；不附加翻译歌词。
 * 播放位置按发送时间戳做实时补偿，播放态下按倍速外推。
 */
const computeDisplayText = (snap: ReturnType<typeof snapshot>): string | null => {
  const main = snap.lyric.filter((line) => !line.isBG);
  if (!main.length) return null;
  const elapsed = snap.playing ? (Date.now() - snap.sendTimestamp) * snap.speed : 0;
  const pos = snap.position + Math.max(0, elapsed);
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
  // 超长行横向滚动，短行直接显示
  return marqueeWindow(full).window;
};

/**
 * 重建 TouchBar。歌词文本/变色分割变化后调用，强制系统重新渲染
 * （Electron TouchBarLabel 存在「值已变更但视觉不刷新」的怪癖，重建可强制刷新）。
 */
const rebuildTouchBar = (): void => {
  if (!isMac) return;
  const { TouchBarSpacer } = TouchBar;
  touchBar = new TouchBar({
    items: [
      favoriteBtn!,
      prevBtn!,
      playPauseBtn!,
      nextBtn!,
      // 左右弹性空白，让中间歌词在剩余区域居中
      new TouchBarSpacer({ size: "flexible" }),
      lyricLabel!,
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

  // 播放/暂停按钮图标切换（仅在状态变化时刷新）
  if (playPauseBtn && lastRenderedPlaying !== playing) {
    playPauseBtn.label = playing ? "⏸" : "▶";
    lastRenderedPlaying = playing;
  }

  // 中间歌词：整行直接显示（超长滚动）；无歌词时显示 ♪ 歌曲名 - 歌手
  const lyric = computeDisplayText(snap);
  let key: string;
  let text: string;
  if (lyric) {
    text = lyric;
    key = `L|${lyric}`;
  } else if (snap.track) {
    const artist = snap.track.artists?.[0]?.name ?? "";
    text = `♪ ${artist ? `${snap.track.title} - ${artist}` : snap.track.title}`;
    key = `T|${text}`;
  } else {
    text = "♪ 等待播放";
    key = "E";
  }
  if (key !== lastRenderedKey) {
    lastRenderedKey = key;
    lyricLabel!.label = text;
    rebuildTouchBar();
  }

  // 节流调试日志：观察歌词是否卡住（位置是否推进、文本是否更新）
  const now = Date.now();
  if (now - lastDebugLogAt > 2000) {
    lastDebugLogAt = now;
    const elapsed = playing ? (now - snap.sendTimestamp) * snap.speed : 0;
    playerLog.info(
      `[touchbar] pos=${Math.round(snap.position)} elapsed=${Math.round(elapsed)} ` +
        `lyricLines=${snap.lyric.length} text="${text}" playing=${playing}`,
    );
  }
};

/** 构建 TouchBar 控件（仅 macOS） */
const buildTouchBar = (): void => {
  if (!isMac || touchBar) return;
  const { TouchBarButton, TouchBarLabel, TouchBarSpacer } = TouchBar;

  favoriteBtn = new TouchBarButton({
    label: "♡",
    click: () => {
      sendToMain("player:event", { type: "toggleLike" });
    },
  });

  const prevButton = new TouchBarButton({
    label: "⏮",
    click: () => {
      sendToMain("player:event", { type: "prev" });
    },
  });
  prevBtn = prevButton;

  playPauseBtn = new TouchBarButton({
    label: "▶",
    click: () => {
      const isPlaying = snapshot().playing;
      sendToMain("player:event", { type: isPlaying ? "pause" : "play" });
    },
  });

  const nextButton = new TouchBarButton({
    label: "⏭",
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
      // 左右弹性空白，让中间歌词在剩余区域居中
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
  renderTimer = setInterval(render, 250);
};

/**
 * 同步当前歌曲收藏状态到 TouchBar（由渲染进程经 IPC 调用）
 * @param liked - 是否已收藏
 */
export const setTouchBarLikeState = (liked: boolean): void => {
  if (!isMac || !favoriteBtn) return;
  favoriteBtn.label = liked ? "♥" : "♡";
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
  lastDebugLogAt = 0;
  marqueeSource = "";
  marqueeStartedAt = 0;
};
