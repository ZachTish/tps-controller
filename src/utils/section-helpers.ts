/**
 * Shared UI section helpers for TPS plugins
 */

export interface SectionConfig {
  title: string;
  description?: string;
  defaultOpen?: boolean;
  cssClass?: string;
  icon?: string;
}

/**
 * Creates a collapsible section with consistent styling
 * @param parent Parent HTML element to append to
 * @param config Configuration for the section
 * @returns Object containing the content element for the section body
 */
export function createCollapsibleSection(
  parent: HTMLElement,
  config: SectionConfig
): HTMLElement {
  const details = parent.createEl("details", { cls: "tps-collapsible-section" });

  if (config.defaultOpen === true) {
    details.setAttr("open", "true");
  }

  if (config.cssClass) {
    details.addClass(config.cssClass);
  }

  const summary = details.createEl("summary");
  summary.addClass("tps-collapsible-section-summary");

  if (config.icon) {
    summary.createSpan({ cls: "tps-collapsible-section-icon", text: config.icon });
  }

  summary.createSpan({ cls: "tps-collapsible-section-title", text: config.title });

  if (config.description) {
    const desc = details.createEl("p", { cls: "tps-collapsible-section-description" });
    desc.setText(config.description);
  }

  const contentEl = details.createDiv({ cls: "tps-collapsible-section-content" });

  return contentEl;
}
