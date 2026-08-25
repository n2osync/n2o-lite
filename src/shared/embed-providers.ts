/**
 * Detects URLs from providers whose content is meant to be embedded, not downloaded.
 *
 * Notion stores YouTube, Vimeo, etc. as `video` blocks with `sourceType: 'external'`.
 * If we hand those URLs to MediaDownloader, the HTTP GET succeeds (the page is HTML),
 * file-type detection fails, and the block ends up saved as `.bin` with the renderer
 * pointing at a local junk file instead of the live embed.
 *
 * For these providers we leave the block at `sourceType: 'external'` so the renderer
 * emits `![caption](url)` (or the equivalent for `embed`/`bookmark`) and Obsidian
 * renders it inline.
 */

const EMBED_ONLY_HOSTS: readonly string[] = [
  'youtube.com',
  'youtu.be',
  'youtube-nocookie.com',
  'vimeo.com',
  'player.vimeo.com',
  'twitch.tv',
  'clips.twitch.tv',
  'tiktok.com',
  'dailymotion.com',
  'loom.com',
  'soundcloud.com',
  'spotify.com',
  'open.spotify.com',
  'twitter.com',
  'x.com',
  'mobile.twitter.com',
  'facebook.com',
  'instagram.com',
  'figma.com',
  'codesandbox.io',
  'codepen.io',
  'replit.com',
  'gist.github.com',
  'maps.google.com',
  'google.com/maps',
];

export function isEmbedOnlyUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    const parsed = new URL(url);
    host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();
    // Special-case for google.com/maps (only the maps path, not the whole domain)
    if (host === 'google.com' || host === 'www.google.com') {
      return path.startsWith('/maps');
    }
  } catch {
    return false;
  }
  // Strip leading "www." for matching
  const stripped = host.startsWith('www.') ? host.slice(4) : host;
  return EMBED_ONLY_HOSTS.some((h) => stripped === h || stripped.endsWith('.' + h));
}
