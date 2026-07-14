// Small DOM helpers shared by platform views. External data must always be
// assigned through textContent/attributes instead of interpolated HTML.

export function element(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  const {
    className,
    text,
    attrs = {},
    dataset = {},
    on = {},
  } = options;

  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);

  for (const [name, value] of Object.entries(attrs)) {
    if (value === false || value === null || value === undefined) continue;
    if (value === true) node.setAttribute(name, '');
    else node.setAttribute(name, String(value));
  }
  for (const [name, value] of Object.entries(dataset)) {
    if (value !== null && value !== undefined) node.dataset[name] = String(value);
  }
  for (const [name, listener] of Object.entries(on)) {
    node.addEventListener(name, listener);
  }

  const list = Array.isArray(children) ? children : [children];
  for (const child of list.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function button(text, options = {}, children = []) {
  const node = element('button', {
    ...options,
    text,
    attrs: { type: 'button', ...(options.attrs || {}) },
  });
  const list = Array.isArray(children) ? children : [children];
  for (const child of list.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node, ...children) {
  node.replaceChildren(...children.flat(Infinity).filter(Boolean));
  return node;
}

export function listen(target, type, listener, options) {
  target.addEventListener(type, listener, options);
  return () => target.removeEventListener(type, listener, options);
}

export function trapEscape(dialog, onClose) {
  const handler = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  };
  document.addEventListener('keydown', handler);
  return () => document.removeEventListener('keydown', handler);
}
