export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Partial<Record<string, string | boolean>> = {},
  children: (Node | string)[] = []
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, String(v));
  }
  for (const c of children) {
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

export function createButton(label: string, onClick: () => void, opts: { variant?: 'default' | 'danger' | 'armed' } = {}): HTMLButtonElement {
  const b = el('button', { type: 'button' }, [label]);
  if (opts.variant && opts.variant !== 'default') b.classList.add(opts.variant);
  b.addEventListener('click', () => {
    try { onClick(); } catch (e) { console.error(e); }
  });
  return b;
}

export interface TextInputOpts {
  type?: 'text' | 'url' | 'number';
  placeholder?: string;
  value?: string;
}

export function createTextInput(opts: TextInputOpts, onChange: (v: string) => void): HTMLInputElement {
  const input = el('input', {
    type: opts.type ?? 'text',
    placeholder: opts.placeholder ?? '',
    value: opts.value ?? ''
  });
  input.addEventListener('change', () => onChange(input.value));
  input.addEventListener('blur', () => onChange(input.value));
  return input;
}

export function createTextarea(value: string, placeholder: string, onCommit: (v: string) => void): HTMLTextAreaElement {
  const ta = el('textarea', { placeholder });
  ta.value = value;
  ta.addEventListener('blur', () => onCommit(ta.value));
  return ta;
}

export function createNumberInput(value: number, onCommit: (v: number) => void): HTMLInputElement {
  const input = el('input', { type: 'number', value: String(value), min: '1' });
  input.addEventListener('blur', () => {
    const n = Number(input.value);
    if (Number.isFinite(n) && n >= 1) onCommit(Math.floor(n));
    else input.value = String(value);
  });
  return input;
}

export interface ModalOpts {
  title: string;
  body: Node | string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

export function showConfirmModal(opts: ModalOpts): Promise<boolean> {
  return new Promise(resolve => {
    const backdrop = el('div', { class: 'modal-backdrop' });
    const modal = el('div', { class: 'modal' });
    const heading = el('h3', {}, [opts.title]);
    const body = el('div', {});
    if (typeof opts.body === 'string') body.textContent = opts.body;
    else body.appendChild(opts.body);

    const actions = el('div', { class: 'actions' });
    const cancel = createButton(opts.cancelLabel ?? 'Cancel', () => done(false));
    const confirm = createButton(
      opts.confirmLabel ?? 'Confirm',
      () => done(true),
      { variant: opts.danger ? 'danger' : 'default' }
    );
    actions.append(cancel, confirm);
    modal.append(heading, body, actions);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    const keydown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') done(false);
      if (e.key === 'Enter') done(true);
    };
    document.addEventListener('keydown', keydown);

    function done(v: boolean) {
      document.removeEventListener('keydown', keydown);
      backdrop.remove();
      resolve(v);
    }
  });
}

export interface InfoModalOpts {
  title: string;
  body: Node | string;
  closeLabel?: string;
}

export function showInfoModal(opts: InfoModalOpts): void {
  const backdrop = el('div', { class: 'modal-backdrop' });
  const modal = el('div', { class: 'modal' });
  const heading = el('h3', {}, [opts.title]);
  const body = el('div', {});
  if (typeof opts.body === 'string') body.textContent = opts.body;
  else body.appendChild(opts.body);

  const actions = el('div', { class: 'actions' });
  const close = createButton(opts.closeLabel ?? 'Close', () => done());
  actions.append(close);
  modal.append(heading, body, actions);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  const keydown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') done();
  };
  document.addEventListener('keydown', keydown);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) done();
  });

  function done() {
    document.removeEventListener('keydown', keydown);
    backdrop.remove();
  }
}

export interface HistoryPickerHandle {
  el: HTMLElement;
  setOptions(values: string[]): void;
}

export function createHistoryPicker(
  placeholder: string,
  onPick: (value: string) => void
): HistoryPickerHandle {
  const select = el('select', { class: 'history-picker' }) as HTMLSelectElement;
  function rebuild(values: string[]): void {
    while (select.firstChild) select.removeChild(select.firstChild);
    const head = el('option', { value: '' }, [placeholder]);
    select.appendChild(head);
    for (const v of values) {
      const o = el('option', { value: v }, [truncateForDisplay(v)]);
      select.appendChild(o);
    }
    select.value = '';
  }
  rebuild([]);
  select.addEventListener('change', () => {
    const v = select.value;
    if (!v) return;
    onPick(v);
    select.value = '';
  });
  return { el: select, setOptions: rebuild };
}

function truncateForDisplay(s: string): string {
  if (s.length <= 32) return s;
  return `${s.slice(0, 14)}…${s.slice(-10)}`;
}

export function clearChildren(n: HTMLElement): void {
  while (n.firstChild) n.removeChild(n.firstChild);
}

export function createCollapsiblePanel(
  title: string,
  storageKey: string,
  defaultOpen = true
): { details: HTMLDetailsElement; content: HTMLElement } {
  const stored = (() => {
    try { return localStorage.getItem(storageKey); } catch { return null; }
  })();
  const isOpen = stored === null ? defaultOpen : stored === '1';
  const details = el('details', { class: 'panel-collapsible' }) as HTMLDetailsElement;
  if (isOpen) details.open = true;
  const summary = el('summary');
  summary.appendChild(el('h2', {}, [title]));
  const content = el('div', { class: 'panel-content' });
  details.append(summary, content);
  details.addEventListener('toggle', () => {
    try { localStorage.setItem(storageKey, details.open ? '1' : '0'); } catch {}
  });
  return { details, content };
}
