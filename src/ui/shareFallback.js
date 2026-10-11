/**
 * Own the manual share-link popover shown when the clipboard is unavailable
 * (no `navigator.clipboard` outside a secure context, or a denied write).
 * The caller supplies the URL and owns toast feedback; the popover owns its
 * listeners, Escape, focus handoff and the `execCommand('copy')` retry.
 *
 * @param {object} options
 * @param {HTMLElement|null} options.root `#share-fallback`, with the data-share-fallback-* parts.
 * @param {Document} [options.documentRef] Document that owns focus and `execCommand`.
 * @param {(message: string) => void} [options.showToast] Existing toast surface.
 * @returns {{show: Function, hide: Function, isOpen: Function, destroy: Function}}
 */
export function createShareFallback({
  root,
  documentRef = root?.ownerDocument,
  showToast = () => {},
}) {
  const inert = { show() {}, hide() {}, isOpen: () => false, destroy() {} };
  if (!root || !documentRef) return inert;
  const input = root.querySelector('[data-share-fallback-url]');
  const copyButton = root.querySelector('[data-share-fallback-copy]');
  const closeButton = root.querySelector('[data-share-fallback-close]');
  if (!input) return inert;
  const removers = [];
  const listen = (target, type, listener) => {
    if (!target) return;
    target.addEventListener(type, listener);
    removers.push(() => target.removeEventListener(type, listener));
  };
  let opener = null;
  let destroyed = false;

  const selectUrl = () => {
    input.focus?.({ preventScroll: true });
    input.select?.();
  };

  const hide = ({ restoreFocus = true } = {}) => {
    if (root.hidden) return;
    root.hidden = true;
    const target = opener;
    opener = null;
    if (restoreFocus && target?.isConnected !== false)
      target?.focus?.({ preventScroll: true });
  };

  const show = (url) => {
    if (destroyed || !url) return;
    if (root.hidden) opener = documentRef.activeElement || null;
    input.value = String(url);
    root.hidden = false;
    selectUrl();
  };

  // execCommand is the one copy path left when the async clipboard is gone;
  // it only works from a user gesture on a selected field, which this is.
  const copy = () => {
    selectUrl();
    let copied = false;
    try {
      copied = documentRef.execCommand?.('copy') === true;
    } catch {
      copied = false;
    }
    showToast(copied ? 'Link copied!' : 'Press Ctrl/Cmd+C to copy the link');
  };

  listen(copyButton, 'click', copy);
  listen(closeButton, 'click', () => hide());
  listen(root, 'keydown', (event) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    hide();
  });

  return {
    show,
    hide,
    isOpen: () => !root.hidden,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const remove of removers.splice(0)) remove();
      hide({ restoreFocus: false });
    },
  };
}
