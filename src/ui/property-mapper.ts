/**
 * PropertyMapper - Per-database property mapping configuration.
 *
 * Lets users rename Notion properties to custom frontmatter keys,
 * exclude properties from sync, and choose value formats.
 */

import { Modal, App } from 'obsidian';
import type { NotionClient } from '../infrastructure/notion/client';
import type { PropertyMapping } from '../settings';

interface PropertyInfo {
  name: string;
  type: string;
}

interface MappingEntry {
  frontmatterKey: string;
  excluded: boolean;
  format?: 'auto' | 'iso' | 'human' | 'tags';
}

export class PropertyMapperModal extends Modal {
  private previousActiveElement: HTMLElement | null = null;
  private properties: PropertyInfo[] = [];
  private mappings: Record<string, MappingEntry>;
  private tableContainerEl!: HTMLElement;

  constructor(
    app: App,
    private notionClient: NotionClient,
    private databaseId: string,
    private databaseName: string,
    currentMapping: PropertyMapping | undefined,
    private onSave: (mapping: PropertyMapping) => void,
  ) {
    super(app);
    this.mappings = currentMapping?.mappings ? structuredClone(currentMapping.mappings) : {};
  }

  override async onOpen(): Promise<void> {
    this.previousActiveElement = document.activeElement as HTMLElement | null;
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: `Property Mapping: ${this.databaseName}` });
    contentEl.createEl('p', {
      text: 'Customize how Notion properties appear in Obsidian frontmatter.',
      cls: 'setting-item-description',
    });

    // Load schema
    const loadingEl = contentEl.createDiv({ text: 'Loading properties...' });
    try {
      this.properties = await this.fetchProperties();
      loadingEl.remove();
    } catch {
      loadingEl.setText('Failed to load database properties.');
      loadingEl.setCssStyles({ color: 'var(--text-error)' });
      return;
    }

    if (this.properties.length === 0) {
      contentEl.createEl('p', { text: 'No properties found.' });
      return;
    }

    // Initialize mappings for properties that don't have one yet
    for (const prop of this.properties) {
      if (!this.mappings[prop.name]) {
        this.mappings[prop.name] = {
          frontmatterKey: this.toFrontmatterKey(prop.name),
          excluded: false,
          format: 'auto',
        };
      }
    }

    // Property table
    this.tableContainerEl = contentEl.createDiv();
    this.renderTable();

    // Footer
    const footer = contentEl.createDiv({
      cls: 'n2o-tree-footer',
      attr: { style: 'margin-top: 16px' },
    });
    footer.createEl('button', { text: 'Reset to defaults' }).addEventListener('click', () => {
      for (const prop of this.properties) {
        this.mappings[prop.name] = {
          frontmatterKey: this.toFrontmatterKey(prop.name),
          excluded: false,
          format: 'auto',
        };
      }
      this.renderTable();
    });
    footer.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
    footer
      .createEl('button', { text: 'Save mapping', cls: 'mod-cta' })
      .addEventListener('click', () => {
        this.onSave({
          databaseId: this.databaseId,
          databaseName: this.databaseName,
          mappings: this.mappings,
        });
        this.close();
      });
  }

  override onClose(): void {
    this.contentEl.empty();
    this.previousActiveElement?.focus();
  }

  // ── Table Rendering ───────────────────────────────────

  private renderTable(): void {
    this.tableContainerEl.empty();

    const table = this.tableContainerEl.createEl('table', { cls: 'n2o-property-table' });

    // Header
    const thead = table.createEl('thead');
    const headerRow = thead.createEl('tr');
    headerRow.createEl('th', { text: 'Notion property' });
    headerRow.createEl('th', { text: 'Type' });
    headerRow.createEl('th', { text: 'Frontmatter key' });
    headerRow.createEl('th', { text: 'Format' });
    headerRow.createEl('th', { text: 'Sync' });

    // Body
    const tbody = table.createEl('tbody');
    for (const prop of this.properties) {
      const mapping = this.mappings[prop.name];
      if (!mapping) continue;
      const row = tbody.createEl('tr');

      // Notion property name
      row.createEl('td', { text: prop.name });

      // Type
      row.createEl('td', { text: prop.type });

      // Frontmatter key input
      const keyCell = row.createEl('td');
      if (mapping.excluded) {
        keyCell.createSpan({ text: ' - ', cls: 'setting-item-description' });
      } else {
        const keyInput = keyCell.createEl('input', { type: 'text' });
        keyInput.value = mapping.frontmatterKey;
        keyInput.addEventListener('input', () => {
          mapping.frontmatterKey = keyInput.value;
        });
      }

      // Format dropdown
      const formatCell = row.createEl('td');
      if (mapping.excluded) {
        formatCell.createSpan({ text: ' - ', cls: 'setting-item-description' });
      } else {
        const formatSelect = formatCell.createEl('select');
        const formats = this.getFormatsForType(prop.type);
        for (const fmt of formats) {
          const opt = formatSelect.createEl('option', { text: fmt.label, value: fmt.value });
          if (fmt.value === (mapping.format ?? 'auto')) opt.selected = true;
        }
        formatSelect.addEventListener('change', () => {
          mapping.format = formatSelect.value as MappingEntry['format'];
        });
      }

      // Sync toggle (checkbox)
      const syncCell = row.createEl('td');
      const syncCheckbox = syncCell.createEl('input', { type: 'checkbox' });
      syncCheckbox.checked = !mapping.excluded;
      syncCheckbox.addEventListener('change', () => {
        mapping.excluded = !syncCheckbox.checked;
        this.renderTable();
      });
    }
  }

  // ── Helpers ───────────────────────────────────────────

  private getFormatsForType(type: string): { label: string; value: string }[] {
    const base = [{ label: 'Auto', value: 'auto' }];

    switch (type) {
      case 'date':
      case 'created_time':
      case 'last_edited_time':
        return [
          ...base,
          { label: 'ISO 8601', value: 'iso' },
          { label: 'Human-readable', value: 'human' },
        ];
      case 'multi_select':
        return [...base, { label: 'As Obsidian tags', value: 'tags' }];
      default:
        return base;
    }
  }

  /**
   * Convert a Notion property name to a frontmatter-friendly key.
   * E.g., "Due Date" -> "due_date", "My Property" -> "my_property"
   */
  private toFrontmatterKey(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
  }

  private async fetchProperties(): Promise<PropertyInfo[]> {
    const db = await this.notionClient.getDatabase(this.databaseId);
    const properties = db.properties;
    if (!properties) return [];

    const result: PropertyInfo[] = [];
    for (const [name, prop] of Object.entries(properties)) {
      result.push({ name, type: prop.type });
    }

    // Sort: title first, then alphabetically
    result.sort((a, b) => {
      if (a.type === 'title') return -1;
      if (b.type === 'title') return 1;
      return a.name.localeCompare(b.name);
    });

    return result;
  }
}
