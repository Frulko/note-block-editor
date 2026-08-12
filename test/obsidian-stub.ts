/**
 * `obsidian` under Vitest.
 *
 * The npm package ships typings and nothing else — the application *is* the
 * runtime, which is why the plugin's esbuild config marks it external. So a
 * test that imports any plugin module needs something under that name for the
 * import to resolve at all, and this is the smallest thing that lets one load.
 *
 * It is deliberately not a fake vault and should not become one. What is worth
 * testing in this plugin is the part that does not touch Obsidian — the
 * inheritance walk, the Markdown a template turns into — and a class here
 * growing behaviour is the sign that a test is reaching for the wrong seam and
 * that the logic under it wants to be pure instead.
 */

export class TAbstractFile {
  path = '';
  name = '';
}
export class TFile extends TAbstractFile {
  basename = '';
  extension = '';
}
export class TFolder extends TAbstractFile {
  children: TAbstractFile[] = [];
}

export class Modal {
  contentEl!: HTMLElement;
  constructor(public app: unknown) {}
  setTitle(_title: string): this {
    return this;
  }
  open(): void {}
  close(): void {}
}

export class Setting {
  constructor(public containerEl: unknown) {}
}

export class PluginSettingTab {
  containerEl!: HTMLElement;
  constructor(
    public app: unknown,
    public plugin: unknown,
  ) {}
}

export class Notice {
  constructor(public message: string) {}
}

export const normalizePath = (path: string): string => path;

/** Called straight through: a test that needs a timer is testing the timer. */
export const debounce = <T>(fn: T): T => fn;

export type App = unknown;
