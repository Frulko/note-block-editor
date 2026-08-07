import { icon } from './icons';
/**
 * File intake primitives shared by every block that accepts media.
 * Kept dependency-free: a File becomes either a base64 data URL (works with
 * zero host wiring) or an opaque asset ref when the host provides a store.
 */

export function pickFile(accept = 'image/*'): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    document.body.append(input);
    let settled = false;
    const finish = (file: File | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(file);
    };
    input.addEventListener('change', () => finish(input.files?.[0] ?? null));
    // a cancelled picker fires no change event in some browsers
    window.addEventListener('focus', () => setTimeout(() => finish(input.files?.[0] ?? null), 300), { once: true });
    input.click();
  });
}

export function fileToDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export interface DropZoneOptions {
  label: string;
  icon?: string;
  accept?: string;
  /** Optional URL field alongside the file picker. */
  urlPlaceholder?: string;
  onFile: (file: File) => void;
  onUrl?: (url: string) => void;
}

/**
 * Empty-media placeholder: click to choose, drop to fill, or paste a URL.
 * Returns the element; the caller owns placement.
 */
export function createDropZone(options: DropZoneOptions): HTMLElement {
  const zone = document.createElement('div');
  zone.className = 'nbe-dropzone';
  zone.dataset['nbeUi'] = '';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'nbe-dropzone-btn';
  // drawn, then labelled: the icon is decorative and the label carries meaning
  // drawn, then labelled: the icon is decorative and the label carries meaning
  button.append(icon(options.icon ?? 'image', { size: 16 }), options.label);
  button.addEventListener('click', async () => {
    const file = await pickFile(options.accept ?? 'image/*');
    if (file) options.onFile(file);
  });
  zone.append(button);

  if (options.onUrl) {
    const url = document.createElement('input');
    url.className = 'nbe-dropzone-url';
    url.placeholder = options.urlPlaceholder ?? 'ou colle une URL, puis Entrée';
    url.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const value = url.value.trim();
      if (value) options.onUrl!(value);
    });
    zone.append(url);
  }

  const setActive = (on: boolean) => zone.classList.toggle('nbe-dropzone-active', on);
  zone.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    e.stopPropagation();
    setActive(true);
  });
  zone.addEventListener('dragleave', () => setActive(false));
  zone.addEventListener('drop', (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    e.preventDefault();
    e.stopPropagation();
    setActive(false);
    options.onFile(file);
  });

  return zone;
}
