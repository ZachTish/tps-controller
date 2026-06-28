/**
 * Standardized list/card rendering with CRUD controls
 */

export interface CardControls {
  canMoveUp?: boolean;
  canMoveDown?: boolean;
  onEdit?: () => void;
  onDelete?: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onDuplicate?: () => void;
  previewEl?: HTMLElement;
  status?: string;
}

export interface ListItemConfig<T> {
  items: T[];
  template: (item: T, index: number) => HTMLElement;
  controls: (item: T, index: number) => CardControls;
  onRefresh?: () => void;
  containerClass?: string;
  emptyState?: string;
}

/**
 * Renders a list of items with standardized card controls
 * Standard button order: Up, Down, Edit, Duplicate, Delete
 */
export function renderListWithControls<T>(
  parent: HTMLElement,
  config: ListItemConfig<T>
): void {
  parent.empty();

  if (config.items.length === 0) {
    const empty = parent.createDiv({ cls: "tps-list-empty-state" });
    empty.setText(config.emptyState || "No items yet");
    return;
  }

  const container = parent.createDiv({ cls: "tps-list-container" });
  if (config.containerClass) {
    container.addClass(config.containerClass);
  }

  config.items.forEach((item, index) => {
    const controls = config.controls(item, index);
    const cardEl = container.createDiv({ cls: "tps-card" });

    // Header with controls
    const header = cardEl.createDiv({ cls: "tps-card-header" });

    // Content section (left side)
    const content = header.createDiv({ cls: "tps-card-content" });

    // Add template content
    const templateEl = config.template(item, index);
    content.appendChild(templateEl);

    // Add preview if provided
    if (controls.previewEl) {
      const preview = header.createDiv({ cls: "tps-card-preview" });
      preview.appendChild(controls.previewEl);
    }

    // Status/description if provided
    if (controls.status) {
      const statusEl = header.createDiv({ cls: "tps-card-status" });
      statusEl.setText(controls.status);
    }

    // Controls section (right side)
    const controlsEl = header.createDiv({ cls: "tps-card-controls" });

    // Move up button
    if (controls.onMoveUp) {
      const upBtn = controlsEl.createEl("button", { cls: "tps-card-btn" });
      upBtn.innerHTML = "↑";
      upBtn.setAttr("aria-label", "Move up");
      upBtn.disabled = controls.canMoveUp === false;
      upBtn.onclick = () => {
        controls.onMoveUp?.();
        config.onRefresh?.();
      };
    }

    // Move down button
    if (controls.onMoveDown) {
      const downBtn = controlsEl.createEl("button", { cls: "tps-card-btn" });
      downBtn.innerHTML = "↓";
      downBtn.setAttr("aria-label", "Move down");
      downBtn.disabled = controls.canMoveDown === false;
      downBtn.onclick = () => {
        controls.onMoveDown?.();
        config.onRefresh?.();
      };
    }

    // Edit button
    if (controls.onEdit) {
      const editBtn = controlsEl.createEl("button", { cls: "tps-card-btn" });
      editBtn.setText("Edit");
      editBtn.onclick = () => {
        controls.onEdit?.();
      };
    }

    // Duplicate button
    if (controls.onDuplicate) {
      const dupBtn = controlsEl.createEl("button", { cls: "tps-card-btn" });
      dupBtn.innerHTML = "⧉";
      dupBtn.setAttr("aria-label", "Duplicate");
      dupBtn.onclick = () => {
        controls.onDuplicate?.();
        config.onRefresh?.();
      };
    }

    // Delete button
    if (controls.onDelete) {
      const delBtn = controlsEl.createEl("button", {
        cls: "tps-card-btn tps-card-btn-danger",
      });
      delBtn.innerHTML = "×";
      delBtn.setAttr("aria-label", "Delete");
      delBtn.onclick = () => {
        controls.onDelete?.();
        config.onRefresh?.();
      };
    }
  });
}
