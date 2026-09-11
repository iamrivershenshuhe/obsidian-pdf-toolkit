export class Component {
  registerDomEvent(el, type, callback, options) { el.addEventListener(type, callback, options); }
  registerEvent() {}
}
export class ItemView extends Component {
  constructor(leaf) { super(); this.app = leaf.app; this.contentEl = document.createElement('div'); document.body.append(this.contentEl); }
}
export class Modal extends Component {}
export class FuzzySuggestModal extends Modal {
  constructor(app) { super(); this.app = app; }
  setPlaceholder() {}
  open() { globalThis.lastPicker = this; }
  onClose() {}
}
export class Setting {}
export class Menu {}
export class FileView {}
export class TFile {}
export class TFolder {}
export class Notice { hide() {} constructor(text) { globalThis.notices.push(text); } }
export const MarkdownRenderer = { async render(app, text, element) { element.textContent = text; } };
export function setIcon(element, icon) { element.dataset.icon = icon; }
export function normalizePath(path) { return path; }
export async function requestUrl({ url }) {
  if (!globalThis.testRequest) throw new Error('Unexpected live network call in test');
  return { text: await globalThis.testRequest(url) };
}
