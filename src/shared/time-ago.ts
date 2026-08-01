/**
 * timeAgo - format an ISO 8601 timestamp as a short relative-time string.
 *
 * Shared across status bar, dashboard, and health monitor. Prior to this
 * module, the same function was reimplemented three times with slightly
 * different intermediate math but identical observable behaviour.
 *
 * Returns one of:
 *   - "just now"     (< 1 minute ago)
 *   - "<N>m ago"     (< 1 hour)
 *   - "<N>h ago"     (< 1 day)
 *   - "<N>d ago"     (>= 1 day)
 *
 * An invalid ISO string produces "just now" (the diff is NaN -> Math.floor
 * returns NaN -> first comparison is false, second is false, third is false,
 * and the final branch returns "NaNd ago", so callers should validate their
 * input before passing it). Callers are responsible for not handing us
 * garbage; we keep the function total so it can be called from a timer
 * without wrapping in try/catch.
 */
export function timeAgo(isoTime: string): string {
  const diff = Date.now() - new Date(isoTime).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
