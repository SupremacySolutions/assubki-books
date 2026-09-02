/**
 * The payment drafts, switched rather than stacked.
 *
 * Six boxes one under another were a wall of text with no sense of which was
 * which, so only one is in front of the owner at a time.
 *
 * Every box stays in the form while it is hidden - a hidden field still
 * submits - so switching never costs an edit and Save writes them all.
 *
 * This lived as a `<script>` block at the foot of the settings page and was
 * dropped during the CSP work; the markup stayed behind, so the tabs rendered
 * and did nothing at all. It is a module now, like the rest, which is both
 * covered by `script-src 'self'` and harder to lose.
 */
for (const group of document.querySelectorAll<HTMLElement>('[data-draft-group]')) {
  const tabs = [...group.querySelectorAll<HTMLButtonElement>('[data-draft-tab]')];
  const panels = [...group.querySelectorAll<HTMLElement>('[data-draft-panel]')];

  const show = (slot: string) => {
    for (const tab of tabs) tab.setAttribute('aria-selected', String(tab.dataset.draftTab === slot));
    for (const panel of panels) panel.hidden = panel.dataset.draftPanel !== slot;
  };

  for (const tab of tabs) {
    tab.addEventListener('click', () => show(tab.dataset.draftTab ?? ''));
  }

  // Renaming one should rename its tab as you type, or the tabs and the names
  // disagree until the page is saved and reloaded.
  for (const input of group.querySelectorAll<HTMLInputElement>('[data-draft-name]')) {
    input.addEventListener('input', () => {
      const tab = tabs.find((b) => b.dataset.draftTab === input.dataset.draftName);
      if (tab) tab.textContent = input.value.trim() || input.placeholder || '';
    });
  }
}
