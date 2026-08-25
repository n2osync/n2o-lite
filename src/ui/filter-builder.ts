/**
 * FilterBuilder - Per-database property filter UI.
 *
 * Lets users define filter conditions for each database (e.g., Status = "Done").
 * Generates Notion API filter objects used during sync to only fetch matching pages.
 */

import { Modal, App, Setting } from 'obsidian';
import type { NotionClient } from '../infrastructure/notion/client';
import type { DatabaseFilter, FilterCondition } from '../settings';

/** Operator options per Notion property type. */
const OPERATORS: Record<string, { label: string; value: string }[]> = {
  title: [
    { label: 'contains', value: 'contains' },
    { label: 'equals', value: 'equals' },
    { label: 'starts with', value: 'starts_with' },
    { label: 'ends with', value: 'ends_with' },
    { label: 'is empty', value: 'is_empty' },
    { label: 'is not empty', value: 'is_not_empty' },
  ],
  rich_text: [
    { label: 'contains', value: 'contains' },
    { label: 'equals', value: 'equals' },
    { label: 'starts with', value: 'starts_with' },
    { label: 'is empty', value: 'is_empty' },
    { label: 'is not empty', value: 'is_not_empty' },
  ],
  select: [
    { label: 'equals', value: 'equals' },
    { label: 'does not equal', value: 'does_not_equal' },
    { label: 'is empty', value: 'is_empty' },
    { label: 'is not empty', value: 'is_not_empty' },
  ],
  multi_select: [
    { label: 'contains', value: 'contains' },
    { label: 'does not contain', value: 'does_not_contain' },
    { label: 'is empty', value: 'is_empty' },
    { label: 'is not empty', value: 'is_not_empty' },
  ],
  status: [
    { label: 'equals', value: 'equals' },
    { label: 'does not equal', value: 'does_not_equal' },
  ],
  checkbox: [{ label: 'equals', value: 'equals' }],
  number: [
    { label: 'equals', value: 'equals' },
    { label: 'does not equal', value: 'does_not_equal' },
    { label: 'greater than', value: 'greater_than' },
    { label: 'less than', value: 'less_than' },
    { label: 'greater or equal', value: 'greater_than_or_equal_to' },
    { label: 'less or equal', value: 'less_than_or_equal_to' },
    { label: 'is empty', value: 'is_empty' },
    { label: 'is not empty', value: 'is_not_empty' },
  ],
  date: [
    { label: 'equals', value: 'equals' },
    { label: 'before', value: 'before' },
    { label: 'after', value: 'after' },
    { label: 'on or before', value: 'on_or_before' },
    { label: 'on or after', value: 'on_or_after' },
    { label: 'past week', value: 'past_week' },
    { label: 'past month', value: 'past_month' },
    { label: 'past year', value: 'past_year' },
    { label: 'is empty', value: 'is_empty' },
    { label: 'is not empty', value: 'is_not_empty' },
  ],
};

/** Notion property types that support filtering. */
const FILTERABLE_TYPES = new Set(Object.keys(OPERATORS));

/** Operators that don't need a value input. */
const VALUELESS_OPERATORS = new Set([
  'is_empty',
  'is_not_empty',
  'past_week',
  'past_month',
  'past_year',
]);

interface DatabaseProperty {
  name: string;
  type: string;
  options?: string[]; // For select/multi_select/status
}

export class FilterBuilderModal extends Modal {
  private previousActiveElement: HTMLElement | null = null;
  private properties: DatabaseProperty[] = [];
  private conditions: FilterCondition[];
  private match: 'and' | 'or';
  private conditionsContainerEl!: HTMLElement;

  constructor(
    app: App,
    private notionClient: NotionClient,
    private databaseId: string,
    private databaseName: string,
    currentFilter: DatabaseFilter | undefined,
    private onSave: (filter: DatabaseFilter) => void,
  ) {
    super(app);
    this.conditions = currentFilter?.conditions ? [...currentFilter.conditions] : [];
    this.match = currentFilter?.match ?? 'and';
  }

  override async onOpen(): Promise<void> {
    this.previousActiveElement = document.activeElement as HTMLElement | null;
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: `Filters: ${this.databaseName}` });
    contentEl.createEl('p', {
      text: 'Only sync pages matching these conditions.',
      cls: 'setting-item-description',
    });

    // Load database schema
    const loadingEl = contentEl.createDiv({ text: 'Loading properties...' });
    try {
      this.properties = await this.fetchDatabaseProperties();
      loadingEl.remove();
    } catch {
      loadingEl.setText('Failed to load database properties.');
      loadingEl.setCssStyles({ color: 'var(--text-error)' });
      return;
    }

    if (this.properties.length === 0) {
      contentEl.createEl('p', { text: 'No filterable properties found.' });
      return;
    }

    // Match mode
    new Setting(contentEl)
      .setName('Match')
      .setDesc('How to combine multiple conditions')
      .addDropdown((dd) =>
        dd
          .addOption('and', 'All conditions')
          .addOption('or', 'Any condition')
          .setValue(this.match)
          .onChange((v) => {
            this.match = v as 'and' | 'or';
          }),
      );

    // Conditions
    this.conditionsContainerEl = contentEl.createDiv();
    this.renderConditions();

    // Add condition button
    contentEl.createEl('button', { text: 'Add condition' }).addEventListener('click', () => {
      const firstProp = this.properties[0];
      if (!firstProp) return;
      const ops = OPERATORS[firstProp.type] ?? OPERATORS.rich_text ?? [];
      const firstOp = ops[0];
      if (!firstOp) return;
      this.conditions.push({
        property: firstProp.name,
        propertyType: firstProp.type,
        operator: firstOp.value,
        value: '',
      });
      this.renderConditions();
    });

    // Footer
    const footer = contentEl.createDiv({
      cls: 'n2o-tree-footer',
      attr: { style: 'margin-top: 16px' },
    });
    footer.createEl('button', { text: 'Clear all' }).addEventListener('click', () => {
      this.conditions = [];
      this.renderConditions();
    });
    footer.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
    footer
      .createEl('button', { text: 'Save filters', cls: 'mod-cta' })
      .addEventListener('click', () => {
        this.onSave({
          databaseId: this.databaseId,
          databaseName: this.databaseName,
          conditions: this.conditions,
          match: this.match,
        });
        this.close();
      });
  }

  override onClose(): void {
    this.contentEl.empty();
    this.previousActiveElement?.focus();
  }

  // ── Condition Rendering ───────────────────────────────

  private renderConditions(): void {
    this.conditionsContainerEl.empty();

    if (this.conditions.length === 0) {
      this.conditionsContainerEl.createEl('p', {
        text: 'No filters - all pages will be synced.',
        cls: 'setting-item-description',
      });
      return;
    }

    for (let i = 0; i < this.conditions.length; i++) {
      this.renderConditionRow(i);
    }
  }

  private renderConditionRow(index: number): void {
    const condition = this.conditions[index];
    if (!condition) return;
    const row = this.conditionsContainerEl.createDiv({ cls: 'n2o-filter-row' });

    // Property selector
    const propSelect = row.createEl('select');
    for (const prop of this.properties) {
      const opt = propSelect.createEl('option', {
        text: `${prop.name} (${prop.type})`,
        value: prop.name,
      });
      if (prop.name === condition.property) opt.selected = true;
    }
    propSelect.addEventListener('change', () => {
      const prop = this.properties.find((p) => p.name === propSelect.value);
      condition.property = propSelect.value;
      condition.propertyType = prop?.type ?? 'rich_text';
      const ops = OPERATORS[condition.propertyType] ?? OPERATORS.rich_text ?? [];
      const firstOp = ops[0];
      if (firstOp) condition.operator = firstOp.value;
      condition.value = '';
      this.renderConditions();
    });

    // Operator selector
    const ops = OPERATORS[condition.propertyType] ?? OPERATORS.rich_text ?? [];
    const opSelect = row.createEl('select');
    for (const op of ops) {
      const opt = opSelect.createEl('option', { text: op.label, value: op.value });
      if (op.value === condition.operator) opt.selected = true;
    }
    opSelect.addEventListener('change', () => {
      condition.operator = opSelect.value;
      this.renderConditions();
    });

    // Value input (skip for valueless operators)
    if (!VALUELESS_OPERATORS.has(condition.operator)) {
      const prop = this.properties.find((p) => p.name === condition.property);

      if (condition.propertyType === 'checkbox') {
        // Boolean toggle
        const cb = row.createEl('select');
        cb.createEl('option', { text: 'True', value: 'true' });
        cb.createEl('option', { text: 'False', value: 'false' });
        cb.value = String(condition.value);
        cb.addEventListener('change', () => {
          condition.value = cb.value === 'true';
        });
      } else if (
        prop?.options &&
        (condition.propertyType === 'select' ||
          condition.propertyType === 'multi_select' ||
          condition.propertyType === 'status')
      ) {
        // Select from known options
        const sel = row.createEl('select');
        for (const opt of prop.options) {
          const el = sel.createEl('option', { text: opt, value: opt });
          if (opt === condition.value) el.selected = true;
        }
        sel.addEventListener('change', () => {
          condition.value = sel.value;
        });
        // Set initial value if empty
        const firstOption = prop.options[0];
        if (!condition.value && firstOption !== undefined) {
          condition.value = firstOption;
        }
      } else if (condition.propertyType === 'number') {
        const input = row.createEl('input', { type: 'number' });
        input.value = String(condition.value ?? '');
        input.addEventListener('change', () => {
          condition.value = Number(input.value);
        });
      } else {
        // Text input
        const input = row.createEl('input', { type: 'text', placeholder: 'Value...' });
        input.value = String(condition.value ?? '');
        input.addEventListener('input', () => {
          condition.value = input.value;
        });
      }
    }

    // Remove button
    const removeBtn = row.createSpan({ text: '✕', cls: 'n2o-filter-remove' });
    removeBtn.addEventListener('click', () => {
      this.conditions.splice(index, 1);
      this.renderConditions();
    });
  }

  // ── Data Fetching ─────────────────────────────────────

  private async fetchDatabaseProperties(): Promise<DatabaseProperty[]> {
    const db = await this.notionClient.getDatabase(this.databaseId);
    const properties = db.properties;
    if (!properties) return [];

    const result: DatabaseProperty[] = [];
    for (const [name, prop] of Object.entries(properties)) {
      const type = prop.type;
      if (!FILTERABLE_TYPES.has(type)) continue;

      let options: string[] | undefined;
      if (type === 'select' && prop.select) {
        options = prop.select.options?.map((o) => o.name);
      } else if (type === 'multi_select' && prop.multi_select) {
        options = prop.multi_select.options?.map((o) => o.name);
      } else if (type === 'status' && prop.status) {
        options = prop.status.options?.map((o) => o.name);
      }

      result.push({ name, type, options });
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
