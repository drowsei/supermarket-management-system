// Minimal DOM for exercising the actual frontend event handlers without a browser.
// This models the controls used by the acceptance tests, not browser layout.
export class TestElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.attributes = {};
    this.listeners = new Map();
    this.dataset = {};
    this.className = '';
    this.textContent = '';
    this.disabled = false;
    this.hidden = false;
    this._value = '';
    this.classList = {
      add: (...names) => { this.className = [...new Set([...this.className.split(' ').filter(Boolean), ...names])].join(' '); },
      remove: (...names) => { this.className = this.className.split(' ').filter((name) => !names.includes(name)).join(' '); },
      contains: (name) => this.className.split(' ').includes(name),
      toggle: (name, force) => {
        const add = force ?? !this.classList.contains(name);
        this.classList[add ? 'add' : 'remove'](name);
        return add;
      },
    };
    this.elements = {
      namedItem: (name) => this.querySelectorAll('input,select,textarea')
        .find((element) => element.attributes.name === name),
    };
  }

  get value() {
    if (this.tagName === 'select') {
      return this.children.some((child) => child.value === this._value) ? this._value : '';
    }
    return this._value;
  }

  set value(value) { this._value = String(value); }
  get selectedOptions() { return this.children.filter((child) => child.value === this.value); }
  get isConnected() { return this.tagName === 'body' || Boolean(this.parentNode?.isConnected); }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'value') this.value = value;
    if (name === 'disabled') this.disabled = true;
    if (name === 'id') this.id = String(value);
  }

  append(...children) {
    for (const child of children) { child.parentNode = this; this.children.push(child); }
  }

  insertBefore(child, reference) {
    const index = this.children.indexOf(reference);
    if (index === -1) return this.append(child);
    child.parentNode = this;
    this.children.splice(index, 0, child);
  }

  replaceChildren(...children) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this.append(...children);
  }

  replaceWith(child) {
    if (!this.parentNode) return;
    const index = this.parentNode.children.indexOf(this);
    this.parentNode.children.splice(index, 1, child);
    child.parentNode = this.parentNode;
    this.parentNode = null;
  }

  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
    this.parentNode = null;
  }

  addEventListener(name, callback) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(callback);
  }

  removeEventListener(name, callback) {
    this.listeners.set(name, (this.listeners.get(name) ?? []).filter((entry) => entry !== callback));
  }

  dispatchEvent(event) {
    if (!event.target) Object.defineProperty(event, 'target', { value: this });
    for (const callback of this.listeners.get(event.type) ?? []) callback(event);
    if (event.bubbles) this.parentNode?.dispatchEvent(event);
    return true;
  }

  async trigger(type, extra = {}) {
    if (type === 'click' && this.disabled) return;
    const event = { type, target: this, preventDefault() {}, stopPropagation() {}, ...extra };
    await Promise.all((this.listeners.get(type) ?? []).map((callback) => callback(event)));
    await flushEvents();
  }

  querySelectorAll(query) {
    const selectors = query.split(',').map((selector) => selector.trim());
    const matches = (element, selector) => {
      if (selector.includes(':not(:disabled)') && element.disabled) return false;
      const base = selector.replace(':not(:disabled)', '');
      if (base.startsWith('.')) return element.classList.contains(base.slice(1));
      if (base.startsWith('#')) return element.attributes.id === base.slice(1);
      if (base === 'a[href]') return element.tagName === 'a' && Object.hasOwn(element.attributes, 'href');
      return element.tagName === base;
    };
    return this.children.flatMap((child) => [
      ...(selectors.some((selector) => matches(child, selector)) ? [child] : []),
      ...child.querySelectorAll(query),
    ]);
  }

  querySelector(query) { return this.querySelectorAll(query)[0] ?? null; }
  focus() { globalThis.document.activeElement = this; }
}

export function installDom() {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const previousCustomEvent = Object.getOwnPropertyDescriptor(globalThis, 'CustomEvent');
  const body = new TestElement('body');
  const document = {
    body,
    activeElement: null,
    createElement: (tag) => new TestElement(tag),
    createElementNS: (_namespace, tag) => new TestElement(tag),
    querySelector: (selector) => body.querySelector(selector),
    addEventListener() {},
    removeEventListener() {},
  };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: document });
  if (!globalThis.CustomEvent) {
    Object.defineProperty(globalThis, 'CustomEvent', {
      configurable: true,
      value: class { constructor(type, options = {}) { this.type = type; Object.assign(this, options); } },
    });
  }
  return {
    body,
    restore() {
      if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
      else delete globalThis.document;
      if (previousCustomEvent) Object.defineProperty(globalThis, 'CustomEvent', previousCustomEvent);
      else delete globalThis.CustomEvent;
    },
  };
}

export const flushEvents = () => new Promise((resolve) => setImmediate(resolve));
