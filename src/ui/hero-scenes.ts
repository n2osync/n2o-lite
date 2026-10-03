/**
 * Hero scenes - the dashboard's hero panel renders ONE scene at a time.
 * Each scene owns its own title/subtitle strings and any animation. This
 * module centralises:
 *   (a) the rules that pick which scene applies to the current state
 *   (b) the self-contained DOM builders for each scene's extras (e.g.
 *       mountRadarScan appends all the radar pieces to a host element)
 *
 * Keep it dependency-light: no imports from obsidian or the plugin root
 * so it stays easy to reason about and test.
 */

import type { DashboardData } from './dashboard-types';

export type HeroScene =
  | 'idle' // In sync, nothing happening - static 100% ring, "All caught up"
  | 'invite' // Connected, nothing picked - "Ready to fill your vault"
  | 'scan' // Discovering pages / finalizing - full radar scan animation
  | 'progress' // Applying changes - % ring fills live
  | 'success' // Just finished (<5s) - brief green flash, transitions to idle
  | 'error' // errors > 0 - red pulse
  | 'attention' // conflicts > 0 && idle - amber breathing
  | 'paused'; // sync paused - dim grey slow breathe

/**
 * Pure decision - given the dashboard data snapshot, which scene plays?
 * Order matters: earlier branches win.
 */
export function deriveHeroScene(d: DashboardData): HeroScene {
  const isSyncing = d.syncState === 'syncing';
  const neverSynced = !d.lastSyncTime && d.totalPages === 0;

  // Paused state overrides everything else while it holds.
  if (d.syncState === 'paused') return 'paused';

  // Tree picker scanning the workspace - runs independently of sync, so
  // handle it BEFORE the sync branches so the radar plays even when no
  // pull is underway.
  if (d.isDiscoveringPages) return 'scan';

  // Active sync branches split by phase.
  if (isSyncing) {
    if (d.syncPhase === 'discovering' || d.syncPhase === 'finalizing') return 'scan';
    return 'progress';
  }

  // Idle branches.
  if (d.errors > 0) return 'error';
  if (d.conflicts > 0) return 'attention';

  // Onboarding - never synced, nothing picked yet.
  if (neverSynced) return 'invite';

  // Success window - 10 second celebration after a clean sync. Keeps
  // the green ring + halo visible long enough to actually register
  // ("ah, it finished cleanly") and gives the user time to glance
  // over from whatever they were doing. Stays under any auto-poll
  // cadence so the scene doesn't flash in and out on re-render.
  if (d.lastSyncTime) {
    const elapsed = Date.now() - new Date(d.lastSyncTime).getTime();
    if (elapsed >= 0 && elapsed < 10000) return 'success';
  }

  // Default: sat quietly.
  return 'idle';
}

/**
 * Mount the full "radar scan" animation inside `host`.
 *
 * Builds the crosshair, bearing ticks, sweep glow, sweep line, and blips
 * as siblings of whatever else is in `host`. All visuals are driven by
 * CSS (`.n2o-dash-radar-*` rules in styles.css); this function only owns
 * the DOM structure and the per-tick animation-delay math.
 *
 * Call `unmountRadarScan(host)` to remove them cleanly.
 */
export function mountRadarScan(host: HTMLElement): void {
  // Guard: idempotent - skip if already mounted.
  if (host.querySelector('.n2o-dash-radar-scan')) return;

  const scan = host.createDiv({ cls: 'n2o-dash-radar-scan' });

  // HUD crosshair through centre - subtle +, radar reticle feel.
  const cross = scan.createDiv({ cls: 'n2o-dash-radar-cross' });
  cross.createDiv({ cls: 'n2o-dash-radar-cross-h' });
  cross.createDiv({ cls: 'n2o-dash-radar-cross-v' });

  // Bearing ticks at cardinal + ordinal directions. Each flashes when
  // the sweep hand passes its angle - delay = (angle/360) * 1.8s.
  const ticks = scan.createDiv({ cls: 'n2o-dash-radar-ticks' });
  for (const a of [0, 45, 90, 135, 180, 225, 270, 315]) {
    const t = ticks.createDiv({ cls: 'n2o-dash-radar-tick' });
    t.style.transform = `rotate(${a}deg)`;
    t.style.animationDelay = `${(a / 360) * 1.8}s`;
  }

  // Bright hotspot following the sweep hand along the ring.
  scan.createDiv({ cls: 'n2o-dash-radar-glow' });

  // The sweep line itself.
  scan.createDiv({ cls: 'n2o-dash-radar-line' });

  // Blips - varied size, staggered delays, scattered on-ring AND inside.
  const blips = scan.createDiv({ cls: 'n2o-dash-radar-blips' });
  const positions = [
    { top: '18%', left: '28%', delay: '0.0s', size: 'm' },
    { top: '30%', left: '76%', delay: '0.4s', size: 'l' },
    { top: '70%', left: '68%', delay: '0.9s', size: 's' },
    { top: '62%', left: '22%', delay: '1.2s', size: 'm' },
    { top: '40%', left: '45%', delay: '1.5s', size: 's' },
    { top: '55%', left: '58%', delay: '1.9s', size: 'l' },
    { top: '35%', left: '35%', delay: '2.3s', size: 's' },
    { top: '50%', left: '78%', delay: '0.7s', size: 's' },
    { top: '48%', left: '18%', delay: '2.0s', size: 'm' },
  ];
  for (const p of positions) {
    const blip = blips.createSpan({ cls: `n2o-dash-radar-blip is-${p.size}` });
    blip.style.top = p.top;
    blip.style.left = p.left;
    blip.style.animationDelay = p.delay;
  }
}

/**
 * Build a "529/1008 / ~24m" counter for the hero subtitle when a sync is
 * mid-flight. Returns null when there's no quantitative data to display
 * (e.g. discovery hasn't reported a total yet, or sync isn't running).
 *
 * Adding this surfaced a real pain point from the 95-min multi-DB sync:
 * the dashboard had ZERO numeric feedback for the entire run. Users had
 * no way to tell if the sync was healthy or stuck.
 */
function formatSyncCounter(d: DashboardData): string | null {
  const p = d.syncProgress;
  if (!p || p.total <= 0) return null;
  // Apply-phase emits already include "N/M" in the message (e.g.
  // "Syncing 9/1008: Yoga Poses"). Avoid duplicating the count by
  // returning ETA only in that case. Discovery-phase emits don't
  // include counts, so we still append the full counter there.
  const messageHasCounter = !!p.message && /\b\d+\s*\/\s*\d+\b/.test(p.message);
  const eta = formatEta(d.syncEtaMs);
  if (messageHasCounter) return eta;
  const counter = `${p.current.toLocaleString()}/${p.total.toLocaleString()}`;
  return eta ? `${counter} \u00B7 ${eta}` : counter;
}

function formatEta(ms: number | null): string | null {
  if (ms == null || ms <= 0) return null;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `~${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `~${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  return `~${hours}h ${remMin}m`;
}

/**
 * Default title/subtitle copy per scene. Returns blank strings when a
 * scene doesn't have canonical copy (e.g. progress - caller supplies
 * live "N/M" numbers). Callers are free to override.
 */
export function sceneCopy(scene: HeroScene, d: DashboardData): { title: string; sub: string } {
  switch (scene) {
    case 'scan': {
      // Prefer the live progress string from whichever process is
      // currently scanning - picker discovery, kebab "Rediscover", or
      // sync-phase discovery. Falls back to static copy if we don't
      // have a message yet.
      const liveMsg =
        d.pageDiscoveryMessage ??
        (d.syncPhase === 'discovering' || d.syncPhase === 'finalizing'
          ? (d.syncProgress?.message ?? null)
          : null);
      const counter = formatSyncCounter(d);
      const baseSub =
        liveMsg ??
        (d.syncPhase === 'finalizing'
          ? 'Wrapping up the sync.'
          : 'Scanning your Notion workspace.');
      return {
        title: d.syncPhase === 'finalizing' ? 'Finalizing\u2026' : 'Discovering pages\u2026',
        sub: counter ? `${baseSub} \u00B7 ${counter}` : baseSub,
      };
    }
    case 'progress': {
      const p = d.syncProgress;
      const counter = formatSyncCounter(d);
      const baseSub = p?.message ?? 'Pulling from Notion\u2026';
      return {
        title: 'Syncing\u2026',
        sub: counter ? `${baseSub} \u00B7 ${counter}` : baseSub,
      };
    }
    case 'idle':
      return {
        title: 'All caught up',
        sub: `${d.totalPages.toLocaleString()} page${d.totalPages === 1 ? '' : 's'} in vault`,
      };
    case 'invite':
      return {
        title: 'Ready to fill your vault',
        sub: `Connected to ${d.workspaceName ?? 'Notion'}. Pick what to bring in.`,
      };
    case 'success':
      return {
        title: 'Done',
        sub: `Synced ${d.totalPages.toLocaleString()} page${d.totalPages === 1 ? '' : 's'}.`,
      };
    case 'error':
      return {
        title: 'Sync had problems',
        sub: `${d.errors} error${d.errors === 1 ? '' : 's'} need review.`,
      };
    case 'attention':
      return {
        title: `${d.conflicts} conflict${d.conflicts === 1 ? '' : 's'}`,
        sub: 'Review to continue syncing.',
      };
    case 'paused':
      return { title: 'Paused', sub: 'Resume when you\u2019re ready.' };
  }
}
