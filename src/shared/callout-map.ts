/**
 * Centralized callout type mapping - single source of truth for all
 * callout type <-> emoji <-> SVG icon conversions used across both adapters.
 */

import { extractBaseName } from './notion-icon-map';

// ── Canonical reverse mapping: callout type -> emoji (for push) ───────

/** Maps Obsidian callout types to their canonical Notion emoji icon. */
export const CALLOUT_TYPE_TO_EMOJI: Record<string, string> = {
  tip: '\u{1F4A1}', // 💡
  success: '\u{2705}', // ✅
  important: '\u{2757}', // ❗
  warning: '\u{26A0}\uFE0F', // ⚠️
  danger: '\u{1F6A8}', // 🚨
  failure: '\u{274C}', // ❌
  info: '\u{2139}\uFE0F', // ℹ️
  note: '\u{1F4DD}', // 📝
  bug: '\u{1F41B}', // 🐛
  question: '\u{2753}', // ❓
  quote: '\u{1F4AC}', // 💬
  abstract: '\u{1F4D6}', // 📖
  example: '\u{1F5D2}\uFE0F', // 🗒️
};

// ── Forward mapping: emoji -> callout type (for pull) ─────────────────

/** Maps Notion emoji icons to Obsidian callout types. */
export const EMOJI_TO_CALLOUT_TYPE: Record<string, string> = {
  // tip
  '\u{1F4A1}': 'tip', // 💡
  '\u{1F4CC}': 'tip', // 📌
  '\u{2728}': 'tip', // ✨
  '\u{1F31F}': 'tip', // 🌟
  '\u{1F4AB}': 'tip', // 💫
  '\u{1F9E0}': 'tip', // 🧠
  '\u{1F50D}': 'tip', // 🔍
  '\u{1F4CE}': 'tip', // 📎
  '\u{1F3AF}': 'tip', // 🎯
  '\u{2B50}': 'tip', // ⭐

  // warning
  '\u{26A0}\uFE0F': 'warning', // ⚠️
  '\u{26A0}': 'warning', // ⚠ (without variant selector)
  '\u{1F525}': 'warning', // 🔥
  '\u{26A1}': 'warning', // ⚡
  '\u{1F4A5}': 'warning', // 💥
  '\u{2622}\uFE0F': 'warning', // ☢️
  '\u{2622}': 'warning', // ☢
  '\u{2623}\uFE0F': 'warning', // ☣️
  '\u{2623}': 'warning', // ☣
  '\u{1F6A7}': 'warning', // 🚧

  // danger
  '\u{1F6A8}': 'danger', // 🚨
  '\u{1F480}': 'danger', // 💀
  '\u{2620}\uFE0F': 'danger', // ☠️
  '\u{2620}': 'danger', // ☠
  '\u{1F4A3}': 'danger', // 💣
  '\u{1F6D1}': 'danger', // 🛑

  // success
  '\u{2705}': 'success', // ✅
  '\u{2714}\uFE0F': 'success', // ✔️
  '\u{2714}': 'success', // ✔
  '\u{1F389}': 'success', // 🎉
  '\u{1F44D}': 'success', // 👍
  '\u{1F3C6}': 'success', // 🏆
  '\u{1F4AA}': 'success', // 💪
  '\u{1F947}': 'success', // 🥇

  // failure
  '\u{274C}': 'failure', // ❌
  '\u{274E}': 'failure', // ❎
  '\u{1F6AB}': 'failure', // 🚫
  '\u{1F44E}': 'failure', // 👎
  '\u{1F494}': 'failure', // 💔

  // important
  '\u{2757}': 'important', // ❗
  '\u{2755}': 'important', // ❕
  '\u{203C}\uFE0F': 'important', // ‼️
  '\u{203C}': 'important', // ‼
  '\u{1F4E3}': 'important', // 📣
  '\u{1F514}': 'important', // 🔔
  '\u{1F6A9}': 'important', // 🚩

  // info
  '\u{2139}\uFE0F': 'info', // ℹ️
  '\u{2139}': 'info', // ℹ
  '\u{1F4C4}': 'info', // 📄
  '\u{1F4CB}': 'info', // 📋
  '\u{1F4CA}': 'info', // 📊

  // question
  '\u{2753}': 'question', // ❓
  '\u{2754}': 'question', // ❔
  '\u{1F914}': 'question', // 🤔
  '\u{1F50E}': 'question', // 🔎

  // quote
  '\u{1F4AC}': 'quote', // 💬
  '\u{1F4AD}': 'quote', // 💭
  '\u{1F5E3}\uFE0F': 'quote', // 🗣️
  '\u{1F5E3}': 'quote', // 🗣
  '\u{270D}\uFE0F': 'quote', // ✍️
  '\u{270D}': 'quote', // ✍

  // abstract
  '\u{1F4D6}': 'abstract', // 📖
  '\u{1F4D3}': 'abstract', // 📓
  '\u{1F4D1}': 'abstract', // 📑
  '\u{1F4DA}': 'abstract', // 📚
  '\u{1F4DC}': 'abstract', // 📜
  '\u{1F4C3}': 'abstract', // 📃

  // example
  '\u{1F5D2}\uFE0F': 'example', // 🗒️
  '\u{1F5D2}': 'example', // 🗒
  '\u{1F9EA}': 'example', // 🧪
  '\u{1F4D0}': 'example', // 📐
  '\u{1F3AD}': 'example', // 🎭

  // note
  '\u{1F4DD}': 'note', // 📝
  '\u{270F}\uFE0F': 'note', // ✏️
  '\u{270F}': 'note', // ✏
  '\u{1F58A}\uFE0F': 'note', // 🖊️
  '\u{1F58A}': 'note', // 🖊
  '\u{1F4C5}': 'note', // 📅

  // bug
  '\u{1F41B}': 'bug', // 🐛
  '\u{1F41E}': 'bug', // 🐞
  '\u{1F577}\uFE0F': 'bug', // 🕷️
  '\u{1F577}': 'bug', // 🕷
};

// ── SVG icon name -> callout type ─────────────────────────────────────

/** Maps Notion built-in SVG icon base names to Obsidian callout types. */
const SVG_NAME_TO_CALLOUT_TYPE: Record<string, string> = {
  lightbulb: 'tip',
  'light-bulb': 'tip',
  warning: 'warning',
  alert: 'danger',
  check: 'success',
  'check-circle': 'success',
  checkmark: 'success',
  verified: 'success',
  fire: 'warning',
  bomb: 'danger',
  'exclamation-mark': 'important',
  exclamation: 'important',
  'question-mark': 'question',
  question: 'question',
  comment: 'quote',
  chat: 'quote',
  'speech-bubble': 'quote',
  book: 'abstract',
  'book-open': 'abstract',
  document: 'note',
  file: 'note',
  pen: 'note',
  pencil: 'note',
  edit: 'note',
  trophy: 'success',
  'thumbs-up': 'success',
  'thumbs-down': 'failure',
  bell: 'important',
  megaphone: 'important',
  flag: 'important',
  target: 'tip',
  bullseye: 'tip',
  star: 'tip',
  barricade: 'warning',
  'traffic-cone': 'warning',
  'push-pin': 'tip',
  pin: 'tip',
  spider: 'bug',
  bug: 'bug',
  info: 'info',
  information: 'info',
};

// ── Color-based fallback ─────────────────────────────────────────────

/** Fallback callout type based on Notion block color (when icon is unknown). */
const COLOR_TO_CALLOUT_HINT: Record<string, string> = {
  red: 'danger',
  orange: 'warning',
  yellow: 'warning',
  green: 'success',
  blue: 'info',
  purple: 'tip',
  pink: 'important',
  brown: 'example',
  gray: 'note',
  default: 'note',
};

// ── Notion built-in icon name -> Unicode emoji ────────────────────────

/**
 * Notion's built-in icon set (aka "Kit") returns `{ type: 'icon', icon: { name, color } }`
 * in the API. We preserve the name in the sidecar for round-trip, and inline
 * the matching emoji into the callout title so the user sees the glyph even
 * though Obsidian's callout chrome has no notion-icon-aware renderer.
 *
 * Keep parallel with SVG_NAME_TO_CALLOUT_TYPE - same names should appear.
 */
const ICON_NAME_TO_EMOJI: Record<string, string> = {
  lightbulb: '\u{1F4A1}', // 💡
  'light-bulb': '\u{1F4A1}', // 💡
  warning: '\u{26A0}\uFE0F', // ⚠️
  alert: '\u{1F6A8}', // 🚨
  check: '\u{2705}', // ✅
  'check-circle': '\u{2705}', // ✅
  checkmark: '\u{2705}', // ✅
  verified: '\u{2705}', // ✅
  fire: '\u{1F525}', // 🔥
  bomb: '\u{1F4A3}', // 💣
  'exclamation-mark': '\u{2757}', // ❗
  exclamation: '\u{2757}', // ❗
  'question-mark': '\u{2753}', // ❓
  question: '\u{2753}', // ❓
  comment: '\u{1F4AC}', // 💬
  chat: '\u{1F4AC}', // 💬
  'speech-bubble': '\u{1F4AC}', // 💬
  book: '\u{1F4D6}', // 📖
  'book-open': '\u{1F4D6}', // 📖
  document: '\u{1F4C4}', // 📄
  file: '\u{1F4C4}', // 📄
  pen: '\u{270F}\uFE0F', // ✏️
  pencil: '\u{270F}\uFE0F', // ✏️
  edit: '\u{270F}\uFE0F', // ✏️
  trophy: '\u{1F3C6}', // 🏆
  'thumbs-up': '\u{1F44D}', // 👍
  'thumbs-down': '\u{1F44E}', // 👎
  bell: '\u{1F514}', // 🔔
  megaphone: '\u{1F4E3}', // 📣
  flag: '\u{1F6A9}', // 🚩
  target: '\u{1F3AF}', // 🎯
  bullseye: '\u{1F3AF}', // 🎯
  star: '\u{2B50}', // ⭐
  barricade: '\u{1F6A7}', // 🚧
  'traffic-cone': '\u{1F6A7}', // 🚧
  'push-pin': '\u{1F4CC}', // 📌
  pin: '\u{1F4CC}', // 📌
  spider: '\u{1F577}\uFE0F', // 🕷️
  bug: '\u{1F41B}', // 🐛
  info: '\u{2139}\uFE0F', // ℹ️
  information: '\u{2139}\uFE0F', // ℹ️
  heart: '\u{2764}\uFE0F', // ❤️
  home: '\u{1F3E0}', // 🏠
  globe: '\u{1F310}', // 🌐
  rocket: '\u{1F680}', // 🚀
};

/** Matches a plain Notion built-in icon name (e.g. "star", "check-circle"). */
const BUILT_IN_ICON_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;

/** True if `icon` looks like a Notion built-in icon name rather than emoji/URL. */
export function isBuiltInIconName(icon: string): boolean {
  return BUILT_IN_ICON_NAME_RE.test(icon);
}

/** Return the Unicode emoji mapped to a Notion built-in icon name, or undefined. */
export function iconNameToEmoji(name: string): string | undefined {
  return ICON_NAME_TO_EMOJI[name];
}

// ── Obsidian alias normalization ─────────────────────────────────────

/** Normalizes Obsidian callout aliases to canonical types. */
const CALLOUT_ALIAS_MAP: Record<string, string> = {
  summary: 'abstract',
  tldr: 'abstract',
  hint: 'tip',
  caution: 'warning',
  attention: 'warning',
  fail: 'failure',
  missing: 'failure',
  error: 'danger',
  check: 'success',
  done: 'success',
  help: 'question',
  faq: 'question',
  cite: 'quote',
};

// ── Exported functions ───────────────────────────────────────────────

/**
 * Extract the base color name from a Notion color string.
 * Strips `_background` suffix: "red_background" -> "red", "blue" -> "blue".
 */
function extractBaseColor(color: string): string {
  return color.replace(/_background$/, '');
}

/**
 * Extract a filename from an SVG URL, returning null for non-SVG URLs.
 */
function extractSvgFilename(url: string): string | null {
  const pathPart = url.split('?')[0] ?? '';
  const segments = pathPart.split('/');
  const last = segments[segments.length - 1];
  if (last && last.includes('.svg')) return last;
  return null;
}

/**
 * Primary resolution: icon + color -> best Obsidian callout type.
 *
 * Algorithm:
 * 1. SVG URL? -> extract base name -> SVG_NAME_TO_CALLOUT_TYPE
 * 2. Emoji? -> EMOJI_TO_CALLOUT_TYPE
 * 3. If result is 'note' or no match -> COLOR_TO_CALLOUT_HINT[baseColor]
 * 4. Fallback -> 'note'
 *
 * Notion's built-in icon-set names (e.g. "star", "warning") deliberately
 * do NOT auto-promote the callout type - they're mostly decorative and
 * users find it jarring when a subtle star-icon callout becomes a loud
 * [!tip]. Visibility of those icons is handled by inlining the matching
 * emoji into the callout title at render time.
 */
export function resolveCalloutType(icon?: string, color?: string): string {
  let result: string | undefined;

  if (icon) {
    // Check if it's an SVG URL
    if (icon.includes('.svg')) {
      const filename = extractSvgFilename(icon);
      if (filename) {
        const baseName = extractBaseName(filename);
        result = SVG_NAME_TO_CALLOUT_TYPE[baseName];
      }
    }

    // Try emoji lookup if SVG didn't match
    if (!result) {
      result = EMOJI_TO_CALLOUT_TYPE[icon];
    }
  }

  // If no match or matched 'note', try color-based fallback
  if ((!result || result === 'note') && color) {
    const baseColor = extractBaseColor(color);
    const colorHint = COLOR_TO_CALLOUT_HINT[baseColor];
    if (colorHint && colorHint !== 'note') {
      result = colorHint;
    }
  }

  return result ?? 'note';
}

/**
 * Reverse mapping: callout type -> canonical emoji (for push to Notion).
 * Returns 📝 for unknown types.
 */
export function calloutTypeToEmoji(calloutType: string): string {
  return CALLOUT_TYPE_TO_EMOJI[calloutType] ?? '\u{1F4DD}'; // Default: 📝
}

/**
 * SVG URL -> callout type directly (skipping emoji intermediary).
 * Returns null if the URL is not an SVG or the icon name is unknown.
 */
export function mapSvgToCalloutType(svgUrl: string): string | null {
  const filename = extractSvgFilename(svgUrl);
  if (!filename) return null;
  const baseName = extractBaseName(filename);
  return SVG_NAME_TO_CALLOUT_TYPE[baseName] ?? null;
}

/**
 * Normalize Obsidian callout aliases to canonical types.
 * Unknown types pass through unchanged.
 */
export function normalizeCalloutType(type: string): string {
  return CALLOUT_ALIAS_MAP[type] ?? type;
}
