/**
 * Frontmatter builder - constructs YAML frontmatter from N2ODocument metadata and properties.
 */

import type { N2ODocument } from '../../domain/models/document';
import type { PageRegistryReader } from '../../domain/models/page-registry';
import type { PropertyMapping } from '../../domain/models/sync-config';
import { mapNotionSvgFilenameToEmoji } from '../../shared/notion-icon-map';
import { sanitizeFileName } from '../../shared/sanitize';
import { escapeYamlString } from '../../shared/yaml';
import { buildFrontmatterProperty } from './property-renderer';

/**
 * Get the active property mapping for the current document's parent database.
 */
function getActivePropertyMapping(
  doc: N2ODocument,
  propertyMappings: PropertyMapping[],
): PropertyMapping | null {
  const dbId = doc.metadata.parentDatabaseId;
  if (!dbId || propertyMappings.length === 0) return null;
  return propertyMappings.find((m) => m.databaseId === dbId) ?? null;
}

/**
 * Build YAML frontmatter from document properties and metadata.
 *
 * @param filePropertyRenderMode - Controls banner/file-property rendering.
 *   'hidden' suppresses banner and bannerOriginal from frontmatter.
 */
export function buildFrontmatter(
  doc: N2ODocument,
  pageRegistry: PageRegistryReader | null,
  propertyMappings: PropertyMapping[],
  filePropertyRenderMode: 'inline' | 'frontmatter' | 'hidden' = 'frontmatter',
): string | null {
  const lines: string[] = ['---'];

  // Section 1: Icon and cover at top (plain filename, no embed syntax in YAML)
  if (doc.icon) {
    let iconValue = doc.icon;

    // Map Notion SVG filenames to emoji equivalents (e.g. "briefcase_gray.svg" -> "💼")
    if (/\.svg$/i.test(iconValue) || (/^[\w-]+$/.test(iconValue) && !iconValue.includes('://'))) {
      const emoji = mapNotionSvgFilenameToEmoji(iconValue);
      if (emoji) iconValue = emoji;
    }

    // Emoji stays as-is, local paths use just filename, URLs stay as-is
    if (!iconValue.includes('://') && !iconValue.includes('/')) {
      // Emoji or plain name
      lines.push(`icon: "${escapeYamlString(iconValue)}"`);
    } else if (!iconValue.includes('://')) {
      // Local path -> plain filename
      const fileName = iconValue.split('/').pop() ?? iconValue;
      lines.push(`icon: "${escapeYamlString(fileName)}"`);
    } else {
      lines.push(`icon: "${escapeYamlString(iconValue)}"`);
    }
  }
  // Banner (cover image) - suppressed in 'hidden' mode
  if (doc.banner && filePropertyRenderMode !== 'hidden') {
    if (!doc.banner.includes('://')) {
      const fileName = doc.banner.split('/').pop() ?? doc.banner;
      lines.push(`banner: "${escapeYamlString(fileName)}"`);
    } else {
      lines.push(`banner: "${escapeYamlString(doc.banner)}"`);
    }
  }
  if (doc.bannerOriginal && filePropertyRenderMode !== 'hidden') {
    const origName = doc.bannerOriginal.split('/').pop() ?? doc.bannerOriginal;
    lines.push(`bannerOriginal: "${escapeYamlString(origName)}"`);
  }

  // Section 2: User properties in the middle (with optional mapping)
  const mapping = getActivePropertyMapping(doc, propertyMappings);
  for (const prop of doc.properties) {
    // Check if this property is excluded by mapping
    const mapEntry = mapping?.mappings[prop.name];
    if (mapEntry?.excluded) continue;

    // Skip "Tags" multiSelect here - handled below with space->hyphen sanitization
    if (prop.type === 'multiSelect' && prop.name.toLowerCase() === 'tags') continue;

    // Use custom frontmatter key if mapped
    const customKey = mapEntry?.frontmatterKey;
    const line = buildFrontmatterProperty(prop, pageRegistry, customKey, mapEntry?.format);
    if (line) lines.push(line);
  }

  // Section 3: Dataview-friendly metadata (aliases, cssclasses, timestamps)
  // Tags: if multi_select property named "Tags" exists, emit as `tags:` for Obsidian + Dataview
  const tagProp = doc.properties.find(
    (p) => p.type === 'multiSelect' && p.name.toLowerCase() === 'tags',
  );
  if (tagProp && Array.isArray(tagProp.value) && (tagProp.value as string[]).length > 0) {
    // Only add tags if not already rendered by buildFrontmatterProperty
    const alreadyRendered = lines.some((l) => l.startsWith('tags:') || l.startsWith('tags '));
    if (!alreadyRendered) {
      const tags = (tagProp.value as string[]).map((t) => {
        // Obsidian tags cannot contain spaces - replace with hyphens
        const sanitized = t.replace(/\s+/g, '-');
        return `  - "${escapeYamlString(sanitized)}"`;
      });
      lines.push(`tags:\n${tags.join('\n')}`);
    }
  }

  // The vault filename is a sanitized (char-replaced, 100-char-capped)
  // rendering of the real Notion title. When the two differ, alias the note
  // under its real name so Obsidian search and linking find it (#1757).
  if (doc.title && sanitizeFileName(doc.title) !== doc.title) {
    lines.push(`aliases:\n  - "${escapeYamlString(doc.title)}"`);
  }

  // Dataview timestamps (quoted to prevent YAML date coercion)
  if (doc.metadata.createdTime) {
    lines.push(`created: "${doc.metadata.createdTime}"`);
  }
  if (doc.metadata.lastEditedTime) {
    lines.push(`updated: "${doc.metadata.lastEditedTime}"`);
  }

  // Section 4: N2O sync metadata at the bottom
  // Always store the raw original Notion title first-class - the filename is
  // lossy (sanitized + truncated), and a push must never fall back to it as
  // the title when the original is known (#1757).
  if (doc.title) lines.push(`notion_title_org: "${escapeYamlString(doc.title)}"`);
  if (doc.notionId) lines.push(`notion_id: "${doc.notionId}"`);
  if (doc.metadata.notionUrl) lines.push(`notion_url: "${doc.metadata.notionUrl}"`);
  if (doc.metadata.type !== 'page') lines.push(`n2o_type: "${doc.metadata.type}"`);
  if (doc.metadata.parentDatabaseId) {
    lines.push(`n2o_database: "${doc.metadata.parentDatabaseId}"`);
  }
  // Parent context (enables recovery + duplicate-copy push without API calls)
  if (doc.metadata.parentId) {
    lines.push(`n2o_parent_id: "${doc.metadata.parentId}"`);
  }
  if (doc.metadata.parentType) {
    lines.push(`n2o_parent_type: "${doc.metadata.parentType}"`);
  }

  lines.push('---');

  return lines.length > 2 ? lines.join('\n') : null;
}
