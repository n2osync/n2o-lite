/**
 * NotionParser - Converts Notion API responses into N2ODocument format.
 */

import type { N2ODocument, N2ODocumentMetadata } from '../../domain/models/document';
import { coerceString } from '../../shared/coerce';
import type {
  N2OBlock,
  N2OBlockType,
  N2ORichText,
  BlockMeta,
  NumberedListMeta,
} from '../../domain/models/block';
import type {
  N2OProperty,
  N2OPropertyType,
  N2OPropertyValue,
  N2ODateValue,
  N2OFormulaValue,
  N2ORelationValue,
} from '../../domain/models/property';
import {
  NOTION_BLOCK_TYPE_MAP,
  NOTION_PROPERTY_TYPE_MAP,
  NOTION_READ_ONLY_PROPERTY_TYPES,
} from '../../domain/services/type-maps';
import { propertyToFrontmatterKey } from '../../shared/sanitize';
import type {
  NotionBlock,
  NotionBlockData,
  NotionCover,
  NotionIcon,
  NotionPage,
  NotionPropertyResponse,
  NotionRichText,
} from '../../domain/models/notion-api-types';
import {
  extractParentId,
  extractParentContainerType,
  getItemTypeFromParent,
} from '../../domain/services/parent-utils';
import { getBlockData } from '../../domain/models/notion-api-types';
import { resolveCalloutType } from '../../shared/callout-map';
import { N2OError } from '../../shared/errors';
import { createLogger } from '../../shared/logger';

const log = createLogger('NotionParser');

/**
 * Normalize whitespace inside a math expression so it renders in Obsidian's
 * reading view. Obsidian's reading-mode math pipeline HTML-encodes a
 * non-breaking space (U+00A0) to the literal text `&nbsp;`, and MathJax then
 * chokes on the `&` with "Misplaced &", falling back to a raw-source error
 * block. A regular space is not encoded and renders fine; whitespace is
 * insignificant in math mode, so this is loss-free. (Narrow no-break U+202F is
 * encoded the same way.) Live Preview is unaffected, which is why it only broke
 * in reading mode.
 */
function normalizeMathWhitespace(expression: string): string {
  return expression.replace(/[\u00A0\u202F]/g, ' ');
}

export class NotionParser {
  /**
   * Parse a Notion page API response into an N2ODocument.
   */
  parsePage(pageResponse: NotionPage, blocks: NotionBlock[]): N2ODocument {
    if (!pageResponse?.id) {
      throw new N2OError('Invalid Notion page response: missing id', 'NOTION_API_ERROR');
    }
    const properties = this.parseProperties(pageResponse.properties ?? {});

    const titleValue = properties.find((p) => p.type === 'title')?.value;
    const title = titleValue == null ? 'Untitled' : coerceString(titleValue);

    const metadata: N2ODocumentMetadata = {
      createdTime: pageResponse.created_time ?? '',
      lastEditedTime: pageResponse.last_edited_time ?? '',
      type: getItemTypeFromParent(pageResponse.parent),
      parentDatabaseId:
        extractParentContainerType(pageResponse.parent) === 'database'
          ? extractParentId(pageResponse.parent)
          : undefined,
      parentId: extractParentId(pageResponse.parent),
      parentType: extractParentContainerType(pageResponse.parent),
      notionUrl: pageResponse.url ?? undefined,
    };

    const parsedBlocks = blocks.map((b) => this.parseBlock(b));

    return {
      id: '',
      notionId: pageResponse.id,
      title,
      properties,
      blocks: parsedBlocks,
      children: [],
      attachments: [],
      metadata,
      icon: this.parseIcon(pageResponse.icon),
      banner: this.parseCover(pageResponse.cover),
    };
  }

  /**
   * Parse a Notion block into N2OBlock.
   */
  parseBlock(block: NotionBlock): N2OBlock {
    const type = block.type;
    const blockData = getBlockData(block);

    const n2oType = this.mapBlockType(type);
    let content = this.parseRichTextArray(blockData?.rich_text ?? []);
    const meta = this.parseBlockMeta(type, blockData);

    // For child_page and child_database, fill pageId from block.id
    if ((type === 'child_page' || type === 'child_database') && meta.kind === 'pageLink') {
      meta.pageId = block.id ?? '';
    }

    // Recursively parse children if the Notion client fetched them
    const rawChildren = block.children;
    const parsedChildren = rawChildren?.map((child) => this.parseBlock(child));

    // Hoist first heading child into empty-title callouts so Obsidian's chrome
    // has something readable. Common Notion pattern: callout with only a
    // decorative icon + child heading as visible label (e.g. "Relationships").
    // The push-side will send the callout back with rich_text filled and the
    // heading child absorbed - visual round-trip stays stable after first push.
    if (
      n2oType === 'callout' &&
      content.every((c) => !c.text) &&
      parsedChildren &&
      parsedChildren.length > 0
    ) {
      const first = parsedChildren[0];
      if (
        first &&
        (first.type === 'heading1' ||
          first.type === 'heading2' ||
          first.type === 'heading3' ||
          first.type === 'heading4') &&
        first.content.length > 0
      ) {
        content = first.content;
        parsedChildren.shift();
      }
    }

    return {
      id: block.id ?? '',
      type: n2oType,
      content,
      children: parsedChildren?.length ? parsedChildren : undefined,
      meta,
    };
  }

  /**
   * Parse Notion rich text array into N2ORichText[].
   */
  parseRichTextArray(richTextArray: NotionRichText[]): N2ORichText[] {
    return richTextArray.map((rt) => this.parseRichText(rt));
  }

  parseRichText(rt: NotionRichText): N2ORichText {
    const annotations = rt.annotations;

    const result: N2ORichText = {
      text: rt.plain_text ?? '',
    };

    if (annotations?.bold) result.bold = true;
    if (annotations?.italic) result.italic = true;
    if (annotations?.strikethrough) result.strikethrough = true;
    if (annotations?.underline) result.underline = true;
    if (annotations?.code) result.code = true;
    if (annotations?.color && annotations.color !== 'default') {
      result.color = annotations.color;
    }

    if (rt.href) {
      result.link = rt.href;
    }

    if (rt.type === 'equation') {
      result.equation = normalizeMathWhitespace(rt.equation?.expression ?? result.text);
    }

    if (rt.type === 'mention') {
      const mention = rt.mention;
      const mentionType = mention?.type ?? 'page';
      result.mention = {
        type: mentionType as
          'page' | 'database' | 'user' | 'date' | 'template_mention' | 'link_preview',
        id: '',
        name: rt.plain_text ?? '',
      };

      if (mention) {
        if (mentionType === 'template_mention' && mention.template_mention) {
          result.mention.type = 'template_mention';
          const tmType = mention.template_mention.type;
          if (tmType === 'template_mention_date') {
            result.mention.templateType =
              mention.template_mention.template_mention_date === 'now' ? 'now' : 'today';
          } else if (tmType === 'template_mention_user') {
            result.mention.templateType = 'me';
          }
        } else if (mentionType === 'link_preview' && mention.link_preview) {
          result.mention.type = 'link_preview';
          result.mention.previewUrl = mention.link_preview.url;
        } else if (mentionType === 'link_mention' && mention.link_mention) {
          // #1724: the official API carries the inline link chip's metadata
          // (title, favicon, provider) - render Notion's chip from it, no fetch.
          const lm = mention.link_mention;
          result.mention.type = 'link_mention';
          result.mention.linkHref = lm.href;
          result.mention.linkTitle = lm.title;
          result.mention.linkIcon = lm.icon_url;
          result.mention.linkDescription = lm.description;
          result.mention.linkProvider = lm.link_provider;
        } else if (mentionType === 'date' && mention.date) {
          result.mention.dateStart = mention.date.start;
          result.mention.dateEnd = mention.date.end ?? undefined;
          // Carry the time zone so an inline @date round-trips without dropping it (#1525).
          if (mention.date.time_zone) result.mention.dateTimeZone = mention.date.time_zone;
        } else {
          const mentionData =
            mentionType === 'page'
              ? mention.page
              : mentionType === 'database'
                ? mention.database
                : mentionType === 'user'
                  ? mention.user
                  : undefined;
          if (mentionData && 'id' in mentionData) {
            result.mention.id = mentionData.id;
          }
        }
      }
    }

    return result;
  }

  /**
   * Parse Notion page properties.
   */
  parseProperties(properties: Record<string, NotionPropertyResponse>): N2OProperty[] {
    const result: N2OProperty[] = [];

    for (const [name, prop] of Object.entries(properties)) {
      const parsed = this.parseProperty(name, prop);
      if (parsed) result.push(parsed);
    }

    return result;
  }

  private parseProperty(name: string, prop: NotionPropertyResponse): N2OProperty | null {
    const type = prop.type;
    const isKnownType = type in NOTION_PROPERTY_TYPE_MAP;
    // Unknown types map to 'text' with value: null. Mark them read-only so
    // the push path never writes null back to Notion.
    const readOnly = !isKnownType || NOTION_READ_ONLY_PROPERTY_TYPES.has(type);
    return {
      name,
      key: propertyToFrontmatterKey(name),
      type: this.mapPropertyType(type),
      value: this.extractPropertyValue(prop),
      notionPropertyId: prop.id,
      readOnly,
    };
  }

  private extractPropertyValue(prop: NotionPropertyResponse): N2OPropertyValue {
    switch (prop.type) {
      case 'title': {
        const arr = prop.title;
        if (!arr || arr.length === 0) return '';
        return arr.map((rt) => rt.plain_text ?? '').join('');
      }
      case 'rich_text': {
        const arr = prop.rich_text;
        if (!arr || arr.length === 0) return '';
        return arr.map((rt) => rt.plain_text ?? '').join('');
      }
      case 'number':
        return prop.number ?? null;
      case 'checkbox':
        return prop.checkbox ?? false;
      case 'url':
        return prop.url ?? null;
      case 'email':
        return prop.email ?? null;
      case 'phone_number':
        return prop.phone_number ?? null;
      case 'select': {
        return prop.select?.name ?? null;
      }
      case 'status': {
        return prop.status?.name ?? null;
      }
      case 'multi_select': {
        const arr = prop.multi_select;
        if (!arr) return [];
        return arr.map((item) => item.name);
      }
      case 'date': {
        const dateObj = prop.date;
        if (!dateObj) return null;
        const dateValue: N2ODateValue = {
          start: dateObj.start,
        };
        if (dateObj.end) dateValue.end = dateObj.end;
        if (dateObj.time_zone) dateValue.timeZone = dateObj.time_zone;
        return dateValue;
      }
      case 'people': {
        const arr = prop.people;
        if (!arr) return [];
        // Store UUID as primary value - append display name after pipe for readability
        return arr.map((person) => (person.name ? `${person.id}|${person.name}` : person.id));
      }
      case 'files': {
        const arr = prop.files;
        if (!arr) return [];
        return arr.map((file) => {
          if (file.type === 'external') {
            return file.external?.url ?? '';
          }
          return file.file?.url ?? '';
        });
      }
      case 'relation': {
        const arr = prop.relation;
        if (!arr) return [];
        return arr.map((rel): N2ORelationValue => ({ id: rel.id }));
      }
      case 'formula': {
        const formulaObj = prop.formula;
        if (!formulaObj) return null;
        const formulaType = formulaObj.type;
        const formulaValue: N2OFormulaValue = {
          type: formulaType as N2OFormulaValue['type'],
          value: null,
        };
        if (formulaType === 'date') {
          formulaValue.value = formulaObj.date?.start ?? null;
        } else if (formulaType === 'string') {
          formulaValue.value = formulaObj.string ?? null;
        } else if (formulaType === 'number') {
          formulaValue.value = formulaObj.number ?? null;
        } else if (formulaType === 'boolean') {
          formulaValue.value = formulaObj.boolean ?? null;
        }
        return formulaValue;
      }
      case 'rollup': {
        const rollupObj = prop.rollup;
        if (!rollupObj) return null;
        const rollupType = rollupObj.type;
        if (rollupType === 'number') return rollupObj.number ?? null;
        if (rollupType === 'date') {
          return rollupObj.date?.start ?? null;
        }
        if (rollupType === 'array') {
          return JSON.stringify(rollupObj.array ?? []);
        }
        return null;
      }
      case 'created_time':
      case 'last_edited_time':
        return (prop[prop.type] as string) ?? null;
      case 'created_by': {
        const userObj = prop.created_by;
        if (!userObj) return null;
        return userObj.name ?? userObj.id;
      }
      case 'last_edited_by': {
        const userObj = prop.last_edited_by;
        if (!userObj) return null;
        return userObj.name ?? userObj.id;
      }
      case 'unique_id': {
        const uidObj = prop.unique_id;
        if (!uidObj) return null;
        const prefix = uidObj.prefix;
        const num = uidObj.number;
        return prefix ? `${prefix}-${num}` : String(num);
      }
      default:
        return null;
    }
  }

  private mapBlockType(notionType: string): N2OBlockType {
    return NOTION_BLOCK_TYPE_MAP[notionType] ?? 'unsupported';
  }

  private mapPropertyType(notionType: string): N2OPropertyType {
    return NOTION_PROPERTY_TYPE_MAP[notionType] ?? 'text';
  }

  private parseBlockMeta(type: string, data: NotionBlockData | undefined): BlockMeta {
    if (!data) return { kind: 'empty' };

    switch (type) {
      case 'code':
        return {
          kind: 'code',
          language: data.language ?? 'plain text',
          caption: this.richTextToPlain(data.caption),
        };
      case 'callout': {
        const icon = this.parseIcon(data.icon);
        const calloutType = resolveCalloutType(icon, data.color);
        log.debug('callout parsed', {
          rawIcon: data.icon,
          parsedIcon: icon,
          color: data.color,
          calloutType,
        });
        return {
          kind: 'callout',
          calloutType,
          icon,
          color: data.color,
        };
      }
      case 'to_do': {
        const todoColor = data.color;
        return {
          kind: 'todo',
          checked: data.checked ?? false,
          color: todoColor && todoColor !== 'default' ? todoColor : undefined,
        };
      }
      case 'equation':
        return { kind: 'equation', expression: normalizeMathWhitespace(data.expression ?? '') };
      case 'image':
      case 'video':
      case 'audio':
      case 'file':
      case 'pdf': {
        const fileType = data.type ?? 'external';
        const source =
          fileType === 'file'
            ? data.file
            : fileType === 'file_upload'
              ? data.file_upload
              : data.external;
        const imageMeta: import('../../domain/models/block').ImageMeta = {
          kind: 'image',
          url:
            (source && 'url' in source ? source.url : source && 'id' in source ? source.id : '') ??
            '',
          sourceType: fileType === 'file' || fileType === 'file_upload' ? 'file' : 'external',
          caption: this.richTextToPlain(data.caption),
        };
        if (data.name) imageMeta.originalFilename = data.name;
        return imageMeta;
      }
      case 'bookmark':
        // The caption is the USER'S annotation and renders below the card;
        // in the title slot it both showed as the card title and blocked the
        // RecordMap enricher's og:title (enricher only fills an empty title).
        return {
          kind: 'bookmark',
          url: data.url ?? '',
          caption: this.richTextToPlain(data.caption) || undefined,
        };
      case 'table':
        return {
          kind: 'table',
          width: data.table_width ?? 0,
          hasColumnHeader: data.has_column_header ?? false,
          hasRowHeader: data.has_row_header ?? false,
        };
      case 'synced_block': {
        const syncedFrom = data.synced_from;
        return {
          kind: 'syncedBlock',
          syncedFrom: syncedFrom ? syncedFrom.block_id : null,
        };
      }
      case 'heading_1': {
        const h1Color = data.color;
        return {
          kind: 'heading',
          level: 1,
          isToggleable: data.is_toggleable,
          color: h1Color && h1Color !== 'default' ? h1Color : undefined,
        };
      }
      case 'heading_2': {
        const h2Color = data.color;
        return {
          kind: 'heading',
          level: 2,
          isToggleable: data.is_toggleable,
          color: h2Color && h2Color !== 'default' ? h2Color : undefined,
        };
      }
      case 'heading_3': {
        const h3Color = data.color;
        return {
          kind: 'heading',
          level: 3,
          isToggleable: data.is_toggleable,
          color: h3Color && h3Color !== 'default' ? h3Color : undefined,
        };
      }
      case 'heading_4': {
        const h4Color = data.color;
        return {
          kind: 'heading',
          level: 4,
          isToggleable: data.is_toggleable,
          color: h4Color && h4Color !== 'default' ? h4Color : undefined,
        };
      }
      case 'table_row': {
        const cells = data.cells ?? [];
        return {
          kind: 'tableRow',
          cells: cells.map((cell) => this.parseRichTextArray(cell)),
        };
      }
      case 'child_page':
        return {
          kind: 'pageLink',
          pageId: '', // Will be filled from block.id by caller
          pageName: data.title ?? undefined,
        };
      case 'child_database':
        return {
          kind: 'pageLink',
          pageId: '', // Will be filled from block.id by caller
          pageName: data.title ?? undefined,
        };
      case 'link_to_page': {
        const pageId = data.page_id ?? data.database_id ?? data.data_source_id ?? '';
        return {
          kind: 'pageLink',
          pageId,
        };
      }
      case 'toggle': {
        const color = data.color;
        return {
          kind: 'paragraph',
          color: color && color !== 'default' ? color : undefined,
        };
      }
      case 'embed':
        return {
          kind: 'bookmark',
          url: data.url ?? '',
          title: this.richTextToPlain(data.caption),
        };
      case 'link_preview':
        // A connected-app live card. The API gives us only the URL (no title,
        // description, cover or the rendered app preview), so we render it as a
        // lean bookmark card. It round-trips as N2OBlockType 'linkPreview' and is
        // preserved on push, never recreated (the API cannot create these).
        return {
          kind: 'bookmark',
          url: data.url ?? '',
        };
      case 'numbered_list_item': {
        const nlColor = data.color;
        const nlMeta: NumberedListMeta = { kind: 'numberedList' };
        const listStartIndex = data.list_start_index;
        if (listStartIndex && listStartIndex !== 1) nlMeta.startIndex = listStartIndex;
        const listFormat = data.list_format;
        if (listFormat && listFormat !== 'numbers') {
          nlMeta.listFormat = listFormat as NumberedListMeta['listFormat'];
        }
        if (nlColor && nlColor !== 'default') nlMeta.color = nlColor;
        // Only return NumberedListMeta if it carries meaningful data
        if (nlMeta.startIndex || nlMeta.listFormat || nlMeta.color) return nlMeta;
        return { kind: 'empty' };
      }
      case 'breadcrumb':
        // The ancestor chain (meta.breadcrumbPath) is stamped later by the
        // pull pipeline's enrichBreadcrumbBlocks - the parser only sees one
        // page and cannot resolve ancestors.
        return { kind: 'breadcrumb' };
      case 'column_list':
        return { kind: 'columnList' };
      case 'column': {
        const widthRatio = data.width_ratio;
        if (widthRatio) return { kind: 'column', widthRatio };
        return { kind: 'column' };
      }
      case 'paragraph':
      case 'bulleted_list_item':
      case 'quote': {
        const blockColor = data.color;
        if (blockColor && blockColor !== 'default') {
          return { kind: 'paragraph', color: blockColor };
        }
        return { kind: 'empty' };
      }
      default:
        return { kind: 'empty' };
    }
  }

  private parseIcon(icon: NotionIcon | undefined | null): string | undefined {
    if (!icon) return undefined;
    if (icon.type === 'emoji') return icon.emoji;
    if (icon.type === 'external') return icon.external.url;
    // file.expiry_time is intentionally not stored - see parseCover for rationale.
    if (icon.type === 'file') return icon.file.url;
    if (icon.type === 'custom_emoji') {
      // Prefer URL (for download), fall back to name as display text
      return icon.custom_emoji.url ?? icon.custom_emoji.name ?? undefined;
    }
    // Notion's built-in icon set ("Kit"): { type: 'icon', icon: { name, color } }.
    // Return the bare name - resolveCalloutType reuses SVG_NAME_TO_CALLOUT_TYPE.
    if (icon.type === 'icon') return icon.icon.name;
    log.debug('parseIcon: unrecognized icon shape', {
      type: (icon as { type?: string }).type,
      icon,
    });
    return undefined;
  }

  private parseCover(cover: NotionCover | undefined | null): string | undefined {
    if (!cover) return undefined;
    if (cover.type === 'external') return cover.external.url;
    // file.expiry_time is intentionally not stored. S3 signed URLs expire in ~1 hour,
    // but the media downloader fetches and caches the file immediately after parse,
    // so the expiry window is never a problem in practice.
    if (cover.type === 'file') return cover.file.url;
    return undefined;
  }

  private richTextToPlain(richText: NotionRichText[] | undefined | null): string | undefined {
    if (!richText || richText.length === 0) return undefined;
    return richText.map((rt) => rt.plain_text ?? '').join('');
  }
}
