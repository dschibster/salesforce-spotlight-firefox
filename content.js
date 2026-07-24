/**
 * Salesforce Spotlight — footer bar, typeahead, keyboard navigation.
 *
 * Firefox DevTools on this script: open DevTools on the Salesforce tab (F12).
 * Console → filter “[Spotlight]”.
 * Debugger → moz-extension://…/content.js → breakpoints.
 * API calls run in the background script with Bearer auth using the My Domain sid.
 * Content script handles UI only and sends messages to background.
 */

(function initSalesforceSpotlight() {
  if (window.__sfnavInjected) {
    return;
  }
  window.__sfnavInjected = true;

  const SFNAV_DEBUG = true;
  /** @param {...unknown} args */
  function dbg(...args) {
    if (SFNAV_DEBUG) console.log('[Spotlight]', ...args);
  }
  /** @param {...unknown} args */
  function dbgWarn(...args) {
    if (SFNAV_DEBUG) console.warn('[Spotlight]', ...args);
  }

  const HOST_ID = 'sfnav-extension-host';
  const SETTINGS_KEY = 'sfnav_settings';
  const DEBOUNCE_MS = 150;
  const MAX_RESULTS = 10;
  /** Slash-command searches are deliberately scoped — allow a longer, scrollable list. */
  const MAX_RESULTS_SLASH = 50;

  /** Corners the reopen button can be pinned to. */
  const BUTTON_POSITIONS = ['bottom-left', 'bottom-right', 'top-left', 'top-right'];

  const DEFAULT_USER_SETTINGS = {
    enabledTypes: {
      Flow: true,
      Object: true,
      LWC: true,
      Apex: true,
      Profile: true,
      PermSet: true,
      PermSetGroup: true,
      Trigger: true,
      VFPage: true,
      Setup: true,
      ObjectSetup: true,
      CMDT: true,
      CustomSetting: true,
      App: true,
    },
    defaultDisplay: 'collapsed',
    /** Small floating button shown while the bar is hidden, to reopen it without the keyboard shortcut. */
    reopenButtonEnabled: true,
    buttonPosition: 'bottom-right',
    /** User-defined setup pages: [{ label, path }] where path is origin-relative. */
    customSetupPages: [],
  };

  /**
   * @param {unknown} raw
   * @returns {{ enabledTypes: Record<string, boolean>, defaultDisplay: 'expanded' | 'collapsed', reopenButtonEnabled: boolean, buttonPosition: string }}
   */
  function mergeUserSettings(raw) {
    const enabledTypes = { ...DEFAULT_USER_SETTINGS.enabledTypes };
    if (raw && typeof raw === 'object' && raw.enabledTypes && typeof raw.enabledTypes === 'object') {
      for (const k of Object.keys(DEFAULT_USER_SETTINGS.enabledTypes)) {
        if (typeof raw.enabledTypes[k] === 'boolean') {
          enabledTypes[k] = raw.enabledTypes[k];
        }
      }
    }
    let defaultDisplay = DEFAULT_USER_SETTINGS.defaultDisplay;
    if (
      raw &&
      typeof raw === 'object' &&
      (raw.defaultDisplay === 'expanded' || raw.defaultDisplay === 'collapsed')
    ) {
      defaultDisplay = raw.defaultDisplay;
    }
    let reopenButtonEnabled = DEFAULT_USER_SETTINGS.reopenButtonEnabled;
    if (raw && typeof raw === 'object' && typeof raw.reopenButtonEnabled === 'boolean') {
      reopenButtonEnabled = raw.reopenButtonEnabled;
    }
    let buttonPosition = DEFAULT_USER_SETTINGS.buttonPosition;
    if (raw && typeof raw === 'object' && BUTTON_POSITIONS.includes(raw.buttonPosition)) {
      buttonPosition = raw.buttonPosition;
    }
    let customSetupPages = [];
    if (raw && typeof raw === 'object' && Array.isArray(raw.customSetupPages)) {
      customSetupPages = raw.customSetupPages
        .filter((p) => p && typeof p.path === 'string' && p.path.startsWith('/'))
        .map((p) => ({ label: String(p.label || p.path), path: p.path }));
    }
    return { enabledTypes, defaultDisplay, reopenButtonEnabled, buttonPosition, customSetupPages };
  }

  /** @type {{ enabledTypes: Record<string, boolean>, defaultDisplay: 'expanded' | 'collapsed', reopenButtonEnabled: boolean, buttonPosition: string }} */
  let userSettings = mergeUserSettings(null);
  /** @type {Record<string, number> | null} */
  let lastCounts = null;
  /** Auto-hide timer: index counts show briefly after load, then vanish (less clutter). */
  let statusHideTimer = null;
  const STATUS_AUTOHIDE_MS = 6000;

  /** Auto-collapse timer: bar closes itself if the input sits unfocused this long. */
  let blurCollapseTimer = null;
  const BLUR_COLLAPSE_MS = 8000;

  /** Inlined from content.css — avoid fetch(chrome-extension://…) which MV3 / page CSP can block. */
  const SFNAV_SHADOW_CSS = `/* Scoped to Shadow DOM root — class names prefixed with sfnav- */

.sfnav-root {
  --sfnav-bg: rgba(15, 23, 42, 0.75);
  --sfnav-border: rgba(255, 255, 255, 0.1);
  --sfnav-glow: rgba(139, 92, 246, 0.15);
  --sfnav-text: #f8fafc;
  --sfnav-muted: #94a3b8;
  --sfnav-input-bg: rgba(255, 255, 255, 0.06);
  --sfnav-accent: #8b5cf6;
  --sfnav-font: "Salesforce Sans", -apple-system, BlinkMacSystemFont, "Segoe UI",
    Roboto, Helvetica, Arial, sans-serif;
  position: fixed;
  left: 50%;
  bottom: 24px;
  transform: translateX(-50%);
  z-index: 2147483646;
  pointer-events: none;
  font-family: var(--sfnav-font);
  font-size: 13px;
  line-height: 1.35;
  box-sizing: border-box;
}

.sfnav-root *,
.sfnav-root *::before,
.sfnav-root *::after {
  box-sizing: border-box;
}

.sfnav-bar {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 16px;
  min-height: 56px;
  padding: 8px 24px;
  background: var(--sfnav-bg);
  border: 1px solid var(--sfnav-border);
  border-radius: 28px;
  backdrop-filter: blur(16px) saturate(180%);
  -webkit-backdrop-filter: blur(16px) saturate(180%);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2), 0 0 0 1px inset rgba(255, 255, 255, 0.05), 0 0 20px var(--sfnav-glow);
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.sfnav-brand-stack {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  line-height: 1.15;
}

.sfnav-brand {
  background: linear-gradient(135deg, #60a5fa, #c084fc);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  font-weight: 800;
  letter-spacing: 0.02em;
  font-size: 13px;
  white-space: nowrap;
}

.sfnav-search-wrap {
  flex: 1 1 auto;
  width: 400px;
  position: relative;
}

.sfnav-input {
  width: 100%;
  height: 40px;
  padding: 0 16px;
  border: 1px solid transparent;
  border-radius: 20px;
  background: var(--sfnav-input-bg);
  color: var(--sfnav-text);
  font-size: 14px;
  outline: none;
  transition: all 0.2s ease;
  box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.1);
}

.sfnav-input::placeholder {
  color: var(--sfnav-muted);
}

.sfnav-input:focus {
  border-color: rgba(139, 92, 246, 0.5);
  background: rgba(255, 255, 255, 0.1);
  box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.1), 0 0 0 3px rgba(139, 92, 246, 0.15);
}

.sfnav-input:disabled {
  opacity: 0.5;
  cursor: wait;
}

/* Native search clear (X) — white icon, pointer cursor, stronger on hover */
.sfnav-input::-webkit-search-cancel-button {
  -webkit-appearance: none;
  appearance: none;
  width: 18px;
  height: 18px;
  margin-right: 6px;
  cursor: pointer;
  background-color: #fff;
  -webkit-mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='%23000' d='M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z'/%3E%3C/svg%3E");
  -webkit-mask-size: 14px 14px;
  -webkit-mask-repeat: no-repeat;
  -webkit-mask-position: center;
  opacity: 0.9;
  transition: opacity 0.15s ease, transform 0.15s ease;
}

.sfnav-input::-webkit-search-cancel-button:hover {
  opacity: 1;
  transform: scale(1.08);
}

.sfnav-input::-webkit-search-cancel-button:active {
  transform: scale(0.95);
}

.sfnav-input::-moz-search-clear-button {
  cursor: pointer;
  filter: brightness(0) invert(1);
  opacity: 0.9;
}

.sfnav-input::-moz-search-clear-button:hover {
  opacity: 1;
}

.sfnav-status {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 320px;
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 12px;
  color: var(--sfnav-muted);
  line-height: 1.25;
}

.sfnav-status-summary {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sfnav-status-summary[hidden] {
  display: none !important;
}

.sfnav-status-grid {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.01em;
}

.sfnav-status-grid[hidden] {
  display: none !important;
}

.sfnav-status-row {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sfnav-status--error {
  color: #fbbf24;
}

.sfnav-status--loading .sfnav-status-summary::before {
  content: "";
  display: inline-block;
  width: 14px;
  height: 14px;
  margin-right: 8px;
  vertical-align: -2px;
  border: 2px solid rgba(255, 255, 255, 0.2);
  border-top-color: #c084fc;
  border-radius: 50%;
  animation: sfnav-spin 0.65s linear infinite;
}

@keyframes sfnav-spin {
  to {
    transform: rotate(360deg);
  }
}

.sfnav-actions {
  flex: 0 0 auto;
  display: flex;
  gap: 10px;
}

.sfnav-btn {
  pointer-events: auto;
  height: 36px;
  padding: 0 16px;
  border: 1px solid var(--sfnav-border);
  border-radius: 18px;
  background: rgba(255, 255, 255, 0.05);
  color: var(--sfnav-text);
  font-family: inherit;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}

.sfnav-btn:hover {
  background: rgba(255, 255, 255, 0.1);
  border-color: rgba(255, 255, 255, 0.2);
  transform: translateY(-1px);
}

.sfnav-btn-close {
  opacity: 0.9;
}

.sfnav-dropdown {
  pointer-events: auto;
  position: absolute;
  left: 50%;
  bottom: calc(100% + 16px);
  transform: translateX(-50%);
  width: min(600px, calc(100vw - 32px));
  max-height: 360px;
  overflow-y: auto;
  padding: 8px;
  /* Lighter glass so more of the page shows through */
  background: rgba(15, 23, 42, 0.7);
  backdrop-filter: blur(20px) saturate(165%);
  -webkit-backdrop-filter: blur(20px) saturate(165%);
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 16px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.22), 0 0 0 1px inset rgba(255, 255, 255, 0.06);
  animation: sfnav-fade-in 0.2s cubic-bezier(0.16, 1, 0.3, 1);
  scrollbar-gutter: stable;
  scrollbar-width: thin;
  scrollbar-color: rgba(192, 132, 252, 0.55) rgba(255, 255, 255, 0.08);
}

.sfnav-dropdown::-webkit-scrollbar {
  width: 8px;
}

.sfnav-dropdown::-webkit-scrollbar-track {
  background: rgba(255, 255, 255, 0.06);
  border-radius: 100px;
  margin: 8px 4px 8px 0;
}

.sfnav-dropdown::-webkit-scrollbar-thumb {
  background: linear-gradient(
    180deg,
    rgba(192, 132, 252, 0.65),
    rgba(96, 165, 250, 0.45)
  );
  border-radius: 100px;
  border: 2px solid transparent;
  background-clip: content-box;
  min-height: 40px;
}

.sfnav-dropdown::-webkit-scrollbar-thumb:hover {
  background: linear-gradient(
    180deg,
    rgba(216, 180, 254, 0.7),
    rgba(125, 211, 252, 0.6)
  );
  background-clip: content-box;
}

.sfnav-dropdown[hidden] {
  display: none !important;
}

@keyframes sfnav-fade-in {
  from {
    opacity: 0;
    transform: translateX(-50%) translateY(10px) scale(0.98);
  }
  to {
    opacity: 1;
    transform: translateX(-50%) translateY(0) scale(1);
  }
}

.sfnav-result {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  text-align: left;
  padding: 10px 14px;
  margin: 2px 0;
  border: none;
  border-radius: 10px;
  background: transparent;
  color: var(--sfnav-text);
  font-family: inherit;
  font-size: 14px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.sfnav-result:hover,
.sfnav-result--active {
  background: rgba(139, 92, 246, 0.2);
  transform: translateX(4px);
}

.sfnav-result-name {
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sfnav-badge {
  flex: 0 0 auto;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 4px 8px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.1);
  color: var(--sfnav-text);
  box-shadow: 0 0 0 1px inset rgba(255, 255, 255, 0.1);
}

.sfnav-badge--flow {
  background: rgba(59, 130, 246, 0.25);
  color: #93c5fd;
  box-shadow: 0 0 0 1px inset rgba(59, 130, 246, 0.3);
}

.sfnav-badge--object {
  background: rgba(16, 185, 129, 0.25);
  color: #6ee7b7;
  box-shadow: 0 0 0 1px inset rgba(16, 185, 129, 0.3);
}

.sfnav-badge--lwc {
  background: rgba(168, 85, 247, 0.25);
  color: #d8b4fe;
  box-shadow: 0 0 0 1px inset rgba(168, 85, 247, 0.3);
}

.sfnav-badge--apex {
  background: rgba(245, 158, 11, 0.25);
  color: #fcd34d;
  box-shadow: 0 0 0 1px inset rgba(245, 158, 11, 0.3);
}

.sfnav-badge--profile {
  background: rgba(239, 68, 68, 0.25);
  color: #fca5a5;
  box-shadow: 0 0 0 1px inset rgba(239, 68, 68, 0.3);
}

.sfnav-badge--permset {
  background: rgba(6, 182, 212, 0.25);
  color: #67e8f9;
  box-shadow: 0 0 0 1px inset rgba(6, 182, 212, 0.3);
}

.sfnav-badge--permsetgroup {
  background: rgba(236, 72, 153, 0.25);
  color: #f9a8d4;
  box-shadow: 0 0 0 1px inset rgba(236, 72, 153, 0.3);
}

.sfnav-badge--trigger {
  background: rgba(234, 88, 12, 0.25);
  color: #fdba74;
  box-shadow: 0 0 0 1px inset rgba(234, 88, 12, 0.3);
}

.sfnav-badge--vfpage {
  background: rgba(99, 102, 241, 0.25);
  color: #a5b4fc;
  box-shadow: 0 0 0 1px inset rgba(99, 102, 241, 0.3);
}

.sfnav-badge--setup {
  background: rgba(148, 163, 184, 0.25);
  color: #cbd5e1;
  box-shadow: 0 0 0 1px inset rgba(148, 163, 184, 0.3);
}

.sfnav-badge--objectsetup {
  background: rgba(20, 184, 166, 0.25);
  color: #5eead4;
  box-shadow: 0 0 0 1px inset rgba(20, 184, 166, 0.3);
}

.sfnav-badge--cmdt {
  background: rgba(132, 204, 22, 0.25);
  color: #bef264;
  box-shadow: 0 0 0 1px inset rgba(132, 204, 22, 0.3);
}

.sfnav-badge--customsetting {
  background: rgba(234, 179, 8, 0.25);
  color: #fde047;
  box-shadow: 0 0 0 1px inset rgba(234, 179, 8, 0.3);
}

.sfnav-badge--app {
  background: rgba(14, 165, 233, 0.25);
  color: #7dd3fc;
  box-shadow: 0 0 0 1px inset rgba(14, 165, 233, 0.3);
}

.sfnav-empty {
  padding: 16px 10px;
  color: var(--sfnav-muted);
  font-size: 14px;
  text-align: center;
}

@media (max-width: 900px) {
  .sfnav-status {
    max-width: 100%;
    flex: 1 1 100%;
    order: 4;
  }

  .sfnav-bar {
    flex-wrap: wrap;
    justify-content: space-between;
    border-radius: 16px;
    padding: 12px 16px;
  }

  .sfnav-search-wrap {
    order: 3;
    flex: 1 1 100%;
    width: 100%;
    margin-top: 8px;
  }
}
`;

  let shadow;
  let els;
  // Server-provided items; `components` is these plus the user's custom setup pages.
  let baseComponents = [];
  let components = [];
  // Lightning UI origin for the current org (from the background), used to build
  // user-defined setup page URLs so a stored path works on any org.
  let uiOrigin = '';
  // Per-host sticky choices (group → picked variant), e.g. { users: 'classic' }.
  // Loaded with each component fetch; a choice hides its not-picked siblings.
  let hostChoices = {};
  let filtered = [];
  let selectedIndex = -1;
  let debounceTimer = null;

  function qs(root, sel) {
    return root.querySelector(sel);
  }

  function loadStylesIntoShadow(shadowRoot) {
    const style = document.createElement('style');
    style.textContent = SFNAV_SHADOW_CSS;
    shadowRoot.appendChild(style);
  }

  function buildFooterHtml() {
    return `
      <div class="sfnav-root" part="root">
        <div class="sfnav-dropdown" id="sfnavDropdown" role="listbox" aria-hidden="true" hidden></div>
        <footer class="sfnav-bar" role="navigation" aria-label="Salesforce Spotlight">
          <div class="sfnav-brand-stack" title="Salesforce Spotlight">
            <div class="sfnav-brand">Salesforce Spotlight</div>
          </div>
          <div class="sfnav-search-wrap">
            <input
              type="search"
              class="sfnav-input"
              id="sfnavInput"
              placeholder="Search anything — type / to filter by type"
              autocomplete="off"
              spellcheck="false"
              aria-label="Search Salesforce components"
              aria-autocomplete="list"
              aria-controls="sfnavDropdown"
              aria-expanded="false"
            />
          </div>
          <div class="sfnav-status" id="sfnavStatus" aria-live="polite">
            <div class="sfnav-status-summary" id="sfnavStatusSummary"></div>
            <div class="sfnav-status-grid" id="sfnavStatusCounts" hidden>
              <div class="sfnav-status-row" id="sfnavStatusRow1"></div>
              <div class="sfnav-status-row" id="sfnavStatusRow2"></div>
              <div class="sfnav-status-row" id="sfnavStatusRow3"></div>
              <div class="sfnav-status-row" id="sfnavStatusRow4"></div>
            </div>
          </div>
          <div class="sfnav-actions">
            <button type="button" class="sfnav-btn" id="sfnavRefresh" title="Refresh list">Refresh</button>
            <button type="button" class="sfnav-btn sfnav-btn-close" id="sfnavClose" title="Hide footer">Close</button>
          </div>
        </footer>
      </div>
    `;
  }

  /** Fade the counts away after a moment; full numbers stay in the tooltip. */
  function scheduleStatusAutoHide() {
    if (statusHideTimer) clearTimeout(statusHideTimer);
    statusHideTimer = setTimeout(() => {
      statusHideTimer = null;
      if (!els) return;
      if (els.statusCounts) els.statusCounts.hidden = true;
      if (els.statusSummary) {
        els.statusSummary.textContent = '';
        els.statusSummary.hidden = true;
      }
    }, STATUS_AUTOHIDE_MS);
  }

  function setStatus(text, kind) {
    if (!els || !els.status) return;
    if (statusHideTimer) {
      clearTimeout(statusHideTimer);
      statusHideTimer = null;
    }
    const isError = kind === 'error';
    const isLoading = kind === 'loading';
    if (els.statusSummary) {
      els.statusSummary.hidden = false;
      els.statusSummary.textContent = text || '';
    }
    if (els.statusCounts) els.statusCounts.hidden = true;
    if (els.statusRow1) els.statusRow1.textContent = '';
    if (els.statusRow2) els.statusRow2.textContent = '';
    if (els.statusRow3) els.statusRow3.textContent = '';
    if (els.statusRow4) els.statusRow4.textContent = '';
    els.status.classList.toggle('sfnav-status--error', isError);
    els.status.classList.toggle('sfnav-status--loading', isLoading);
  }

  /** Ready: three rows of counts; respects enabled types from settings. */
  function setReadyStatus(counts, itemFallback) {
    if (!els || !els.status) return;
    els.status.classList.remove('sfnav-status--error', 'sfnav-status--loading');
    const c = counts;
    const en = userSettings.enabledTypes;
    if (c && typeof c.flows === 'number') {
      const parts1 = [];
      if (en.Flow) parts1.push(`${c.flows ?? 0} flows`);
      if (en.Object) parts1.push(`${c.objects ?? 0} objects`);
      if (en.Profile) parts1.push(`${c.profiles ?? 0} profiles`);
      const parts2 = [];
      if (en.LWC) parts2.push(`${c.lwc ?? 0} LWC`);
      if (en.Apex) parts2.push(`${c.apex ?? 0} Apex`);
      if (en.Trigger) parts2.push(`${c.triggers ?? 0} triggers`);
      const parts3 = [];
      if (en.PermSet) parts3.push(`${c.permSets ?? 0} perm sets`);
      if (en.PermSetGroup) parts3.push(`${c.permSetGroups ?? 0} perm set groups`);
      if (en.VFPage) parts3.push(`${c.vfPages ?? 0} VF pages`);
      const parts4 = [];
      if (en.Setup) parts4.push(`${c.setup ?? 0} setup pages`);
      if (en.ObjectSetup) parts4.push(`${c.objectSetup ?? 0} object setup links`);
      if (en.CMDT) parts4.push(`${c.cmdt ?? 0} CMDT`);
      if (en.CustomSetting) parts4.push(`${c.customSettings ?? 0} custom settings`);
      if (en.App) parts4.push(`${c.apps ?? 0} apps`);

      if (parts1.length === 0 && parts2.length === 0 && parts3.length === 0 && parts4.length === 0) {
        if (els.statusCounts) els.statusCounts.hidden = true;
        if (els.statusSummary) {
          els.statusSummary.hidden = false;
          els.statusSummary.textContent = 'All search types disabled in settings';
        }
        return;
      }

      if (els.statusSummary) {
        els.statusSummary.textContent = '';
        els.statusSummary.hidden = true;
      }
      if (els.statusRow1) els.statusRow1.textContent = parts1.length ? parts1.join(' · ') : '—';
      if (els.statusRow2) els.statusRow2.textContent = parts2.length ? parts2.join(' · ') : '—';
      if (els.statusRow3) els.statusRow3.textContent = parts3.length ? parts3.join(' · ') : '—';
      if (els.statusRow4) els.statusRow4.textContent = parts4.length ? parts4.join(' · ') : '—';
      if (els.statusCounts) els.statusCounts.hidden = false;
      els.status.title = [...parts1, ...parts2, ...parts3, ...parts4].join('\n');
      scheduleStatusAutoHide();
    } else {
      if (els.statusCounts) els.statusCounts.hidden = true;
      if (els.statusSummary) {
        els.statusSummary.hidden = false;
        els.statusSummary.textContent = itemFallback != null ? `${itemFallback} items` : '';
      }
      scheduleStatusAutoHide();
    }
  }

  function fetchComponents(forceRefresh) {
    const tabUrl = window.location.href;
    dbg('sendMessage fetchComponents', { tabUrl, forceRefresh });
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        {
          action: 'fetchComponents',
          tabUrl,
          forceRefresh: Boolean(forceRefresh),
        },
        (response) => {
          if (chrome.runtime.lastError) {
            dbgWarn('sendMessage lastError', chrome.runtime.lastError.message);
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          dbg('sendMessage response', {
            ok: response && response.ok,
            cached: response && response.cached,
            counts: response && response.counts,
            len: response && response.components && response.components.length,
            error: response && response.error,
          });
          resolve(response || { ok: false, error: 'No response' });
        }
      );
    });
  }

  /** Fire-and-forget: tell the background to remember a per-host choice. */
  function recordChoice(choiceGroup, choiceVariant) {
    try {
      chrome.runtime.sendMessage(
        { action: 'setChoice', tabUrl: window.location.href, choiceGroup, choiceVariant },
        () => void chrome.runtime.lastError // swallow "no receiver" noise
      );
    } catch (e) {
      dbgWarn('recordChoice failed', e);
    }
  }

  async function loadComponents(forceRefresh) {
    setStatus(forceRefresh ? 'Refreshing…' : 'Loading components…', 'loading');
    if (els && els.input) els.input.disabled = true;

    const result = await fetchComponents(forceRefresh);

    if (els && els.input) els.input.disabled = false;

    if (!result.ok) {
      components = [];
      lastCounts = null;
      dbgWarn('loadComponents failed', result.error);
      setStatus(result.error || 'Failed to load.', 'error');
      return;
    }

    baseComponents = Array.isArray(result.components) ? result.components : [];
    hostChoices = result.choices && typeof result.choices === 'object' ? result.choices : {};
    if (typeof result.uiOrigin === 'string' && result.uiOrigin) uiOrigin = result.uiOrigin;
    lastCounts = result.counts && typeof result.counts === 'object' ? result.counts : null;
    rebuildComponents();
    dbg('loadComponents OK', 'in-memory length', components.length);
    setReadyStatus(lastCounts, components.length);
  }

  /** Map the user's saved setup pages to searchable Setup items on the current org. */
  function buildCustomSetupItems() {
    if (!uiOrigin) return [];
    const base = uiOrigin.replace(/\/$/, '');
    return (userSettings.customSetupPages || []).map((p) => ({
      type: 'Setup',
      name: p.label,
      searchText: `${p.label} ${p.path} setup`.toLowerCase(),
      url: `${base}${p.path}`,
    }));
  }

  /** `components` = server items + the user's custom setup pages. */
  function rebuildComponents() {
    components = baseComponents.concat(buildCustomSetupItems());
  }

  function normalizeQuery(q) {
    return (q || '').trim().toLowerCase();
  }

  /** Slash commands: restrict the search to one component type, e.g. "/app nebula". */
  const SLASH_COMMANDS = [
    { cmd: 'app', type: 'App', hint: 'Apps' },
    { cmd: 'flow', type: 'Flow', hint: 'Flows' },
    { cmd: 'object', type: 'Object', hint: 'Objects' },
    { cmd: 'setup', type: 'Setup', hint: 'Setup pages' },
    { cmd: 'objsetup', type: 'ObjectSetup', hint: 'Object Manager pages' },
    { cmd: 'cmdt', type: 'CMDT', hint: 'Custom metadata types' },
    { cmd: 'cs', type: 'CustomSetting', hint: 'Custom settings' },
    { cmd: 'apex', type: 'Apex', hint: 'Apex classes' },
    { cmd: 'lwc', type: 'LWC', hint: 'Lightning web components' },
    { cmd: 'profile', type: 'Profile', hint: 'Profiles' },
    { cmd: 'permset', type: 'PermSet', hint: 'Permission sets' },
    { cmd: 'psg', type: 'PermSetGroup', hint: 'Permission set groups' },
    { cmd: 'trigger', type: 'Trigger', hint: 'Apex triggers' },
    { cmd: 'vf', type: 'VFPage', hint: 'Visualforce pages' },
  ];
  /** Extra aliases → type (not shown in the command list). */
  const SLASH_ALIASES = {
    obj: 'Object',
    class: 'Apex',
    ps: 'PermSet',
    permsetgroup: 'PermSetGroup',
    vfpage: 'VFPage',
    os: 'ObjectSetup',
    anwendung: 'App',
    customsetting: 'CustomSetting',
    setting: 'CustomSetting',
    settings: 'CustomSetting',
  };
  const SLASH_TYPE_BY_CMD = (() => {
    const m = { ...SLASH_ALIASES };
    for (const c of SLASH_COMMANDS) m[c.cmd] = c.type;
    return m;
  })();

  /**
   * @returns {{ kind: 'search', type: string | null, q: string } | { kind: 'commands', prefix: string }}
   */
  function parseQuery(query) {
    const trimmed = normalizeQuery(query);
    if (!trimmed.startsWith('/')) return { kind: 'search', type: null, q: trimmed };
    const sp = trimmed.indexOf(' ');
    const tok = sp === -1 ? trimmed.slice(1) : trimmed.slice(1, sp);
    const type = SLASH_TYPE_BY_CMD[tok];
    if (type) {
      return { kind: 'search', type, q: sp === -1 ? '' : trimmed.slice(sp + 1).trim() };
    }
    return { kind: 'commands', prefix: tok };
  }

  /**
   * Multi-token fuzzy match: split query into words, every word must appear
   * somewhere in the haystack. "send pdf" matches "NOVA Automatic Send Quote PDF".
   * Scoring: exact substring > all-tokens-match; earlier positions rank higher.
   */
  /** A resolved choice group hides its not-picked siblings. */
  function choiceHidden(item) {
    if (!item.choiceGroup) return false;
    const picked = hostChoices[item.choiceGroup];
    return picked != null && picked !== item.choiceVariant;
  }

  function filterComponents(query) {
    const parsed = parseQuery(query);

    // "/" or unknown command → suggest commands as selectable pseudo-items.
    // Types the user has turned off in settings are left out of the suggestion list.
    if (parsed.kind === 'commands') {
      return SLASH_COMMANDS
        .filter((c) => c.cmd.startsWith(parsed.prefix) && userSettings.enabledTypes[c.type])
        .map((c) => ({ isCommand: true, cmd: c.cmd, type: c.type, name: `/${c.cmd} — ${c.hint}` }));
    }

    const q = parsed.q;
    const restrictType = parsed.type;

    const limit = restrictType ? MAX_RESULTS_SLASH : MAX_RESULTS;

    // Bare command like "/app" → list everything of that type.
    if (!q && restrictType) {
      return components
        .filter((item) => item.type === restrictType && !choiceHidden(item))
        .sort((a, b) => (a.rank || 0) - (b.rank || 0) || a.name.localeCompare(b.name))
        .slice(0, limit);
    }
    if (!q) return [];

    const tokens = q.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return [];

    const scored = [];
    for (let i = 0; i < components.length; i += 1) {
      const item = components[i];
      if (choiceHidden(item)) continue;
      if (restrictType) {
        // Explicit slash command overrides the type toggles in settings.
        if (item.type !== restrictType) continue;
      } else if (!userSettings.enabledTypes[item.type]) {
        continue;
      }
      const hay = item.searchText || item.name.toLowerCase();

      const rank = item.rank || 0;

      const exactIdx = hay.indexOf(q);
      if (exactIdx !== -1) {
        scored.push({ item, score: 0, rank, pos: exactIdx, name: item.name });
        continue;
      }

      let allMatch = true;
      let sumPos = 0;
      for (let t = 0; t < tokens.length; t += 1) {
        const idx = hay.indexOf(tokens[t]);
        if (idx === -1) {
          allMatch = false;
          break;
        }
        sumPos += idx;
      }
      if (allMatch) {
        scored.push({ item, score: 1, rank, pos: sumPos, name: item.name });
      }
    }

    scored.sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score;
      // rank: deep links (Object Manager sub-pages) sort after primary items
      if (a.rank !== b.rank) return a.rank - b.rank;
      if (a.pos !== b.pos) return a.pos - b.pos;
      return a.name.localeCompare(b.name);
    });

    return scored.slice(0, limit).map((s) => s.item);
  }

  function badgeClass(type) {
    switch (type) {
      case 'Flow':
        return 'sfnav-badge sfnav-badge--flow';
      case 'Object':
        return 'sfnav-badge sfnav-badge--object';
      case 'LWC':
        return 'sfnav-badge sfnav-badge--lwc';
      case 'Apex':
        return 'sfnav-badge sfnav-badge--apex';
      case 'Profile':
        return 'sfnav-badge sfnav-badge--profile';
      case 'PermSet':
        return 'sfnav-badge sfnav-badge--permset';
      case 'PermSetGroup':
        return 'sfnav-badge sfnav-badge--permsetgroup';
      case 'Trigger':
        return 'sfnav-badge sfnav-badge--trigger';
      case 'VFPage':
        return 'sfnav-badge sfnav-badge--vfpage';
      case 'Setup':
        return 'sfnav-badge sfnav-badge--setup';
      case 'ObjectSetup':
        return 'sfnav-badge sfnav-badge--objectsetup';
      case 'CMDT':
        return 'sfnav-badge sfnav-badge--cmdt';
      case 'CustomSetting':
        return 'sfnav-badge sfnav-badge--customsetting';
      case 'App':
        return 'sfnav-badge sfnav-badge--app';
      default:
        return 'sfnav-badge';
    }
  }

  function renderDropdown() {
    if (!els || !els.dropdown || !els.input) return;

    els.dropdown.innerHTML = '';
    selectedIndex = filtered.length ? 0 : -1;

    if (!filtered.length) {
      const q = normalizeQuery(els.input.value);
      if (!q) {
        els.dropdown.hidden = true;
        els.dropdown.setAttribute('aria-hidden', 'true');
        els.input.setAttribute('aria-expanded', 'false');
        return;
      }
      const empty = document.createElement('div');
      empty.className = 'sfnav-empty';
      empty.textContent = 'No matches.';
      els.dropdown.appendChild(empty);
    } else {
      filtered.forEach((item, i) => {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'sfnav-result' + (i === selectedIndex ? ' sfnav-result--active' : '');
        row.setAttribute('role', 'option');
        row.setAttribute('data-index', String(i));
        const badge = document.createElement('span');
        badge.className = badgeClass(item.type);
        badge.textContent = item.type;
        const name = document.createElement('span');
        name.className = 'sfnav-result-name';
        name.textContent = item.name;
        row.appendChild(badge);
        row.appendChild(name);
        row.addEventListener('mousedown', (e) => {
          e.preventDefault();
          openItem(item);
        });
        els.dropdown.appendChild(row);
      });
    }

    els.dropdown.hidden = false;
    els.dropdown.setAttribute('aria-hidden', 'false');
    els.input.setAttribute('aria-expanded', 'true');
    updateActiveRow();
  }

  function updateActiveRow() {
    if (!els || !els.dropdown) return;
    const rows = els.dropdown.querySelectorAll('.sfnav-result');
    rows.forEach((row, i) => {
      const active = i === selectedIndex;
      row.classList.toggle('sfnav-result--active', active);
      row.setAttribute('aria-selected', active ? 'true' : 'false');
      if (active) {
        row.scrollIntoView({ block: 'nearest' });
      }
    });
  }

  function openItem(item) {
    if (!item) return;
    // Selecting a command suggestion completes it in the input instead of navigating.
    if (item.isCommand) {
      if (els && els.input) {
        els.input.value = `/${item.cmd} `;
        els.input.focus();
        filtered = filterComponents(els.input.value);
        renderDropdown();
      }
      return;
    }
    if (!item.url) return;
    // Sticky per-host choice: opening one variant of a choice group hides its
    // siblings immediately (via hostChoices) and persists so it survives
    // reloads until the cache is flushed.
    if (item.choiceGroup) {
      hostChoices[item.choiceGroup] = item.choiceVariant;
      recordChoice(item.choiceGroup, item.choiceVariant);
    }
    window.open(item.url, '_blank', 'noopener,noreferrer');
    if (els && els.input) {
      els.input.value = '';
    }
    filtered = [];
    if (els && els.dropdown) {
      els.dropdown.hidden = true;
      els.dropdown.setAttribute('aria-hidden', 'true');
      els.input.setAttribute('aria-expanded', 'false');
      els.dropdown.innerHTML = '';
    }
    selectedIndex = -1;
  }

  function onInput() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (!els || !els.input) return;
      filtered = filterComponents(els.input.value);
      renderDropdown();
    }, DEBOUNCE_MS);
  }

  function onKeyDown(e) {
    if (!els || !els.dropdown || els.dropdown.hidden) {
      if (e.key === 'Escape') {
        e.preventDefault();
        hideFooter();
      }
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (filtered.length) {
        selectedIndex = Math.min(selectedIndex + 1, filtered.length - 1);
        updateActiveRow();
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (filtered.length) {
        selectedIndex = Math.max(selectedIndex - 1, 0);
        updateActiveRow();
      }
    } else if (e.key === 'Enter') {
      if (selectedIndex >= 0 && filtered[selectedIndex]) {
        e.preventDefault();
        openItem(filtered[selectedIndex]);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      els.dropdown.hidden = true;
      els.dropdown.setAttribute('aria-hidden', 'true');
      els.input.setAttribute('aria-expanded', 'false');
      els.dropdown.innerHTML = '';
      selectedIndex = -1;
    }
  }

  const REOPEN_ID = 'sfnav-reopen-button';

  /** Inline style string for the floating reopen button, anchored to the chosen corner. */
  function reopenButtonStyle(position) {
    const pos = BUTTON_POSITIONS.includes(position) ? position : DEFAULT_USER_SETTINGS.buttonPosition;
    const vertical = pos.startsWith('top') ? 'top:24px' : 'bottom:24px';
    const horizontal = pos.endsWith('left') ? 'left:24px' : 'right:24px';
    return [
      'position:fixed',
      vertical,
      horizontal,
      'z-index:2147483645',
      'padding:10px 18px',
      'text-align:center',
      'font-family:"Salesforce Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif',
      'font-size:14px',
      'font-weight:600',
      'line-height:1.15',
      'background:linear-gradient(135deg, #60a5fa, #c084fc)',
      'color:#fff',
      'border:none',
      'border-radius:24px',
      'cursor:pointer',
      'box-shadow:0 8px 24px rgba(139, 92, 246, 0.3)',
      'transition:transform 0.2s cubic-bezier(0.4, 0, 0.2, 1), box-shadow 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
    ].join(';');
  }

  function removeReopenButton() {
    const btn = document.getElementById(REOPEN_ID);
    if (btn) btn.remove();
  }

  /** Small floating button shown while the bar is hidden — click to reopen. Position/visibility come from settings. */
  function showReopenButton() {
    if (!userSettings.reopenButtonEnabled) return;
    const existing = document.getElementById(REOPEN_ID);
    if (existing) {
      existing.setAttribute('style', reopenButtonStyle(userSettings.buttonPosition));
      return;
    }
    const btn = document.createElement('button');
    btn.id = REOPEN_ID;
    btn.type = 'button';
    btn.title = 'Salesforce Spotlight';
    btn.textContent = 'Spotlight';
    btn.setAttribute('style', reopenButtonStyle(userSettings.buttonPosition));
    btn.addEventListener('mouseover', () => {
      btn.style.transform = 'translateY(-2px) scale(1.02)';
      btn.style.boxShadow = '0 12px 32px rgba(139, 92, 246, 0.4)';
    });
    btn.addEventListener('mouseout', () => {
      btn.style.transform = 'translateY(0) scale(1)';
      btn.style.boxShadow = '0 8px 24px rgba(139, 92, 246, 0.3)';
    });
    btn.addEventListener('click', () => showFooter());
    document.body.appendChild(btn);
  }

  function hideFooter() {
    clearBlurCollapse();
    const host = document.getElementById(HOST_ID);
    if (host) {
      host.style.display = 'none';
    }
    showReopenButton();
  }

  function showFooter() {
    const host = document.getElementById(HOST_ID);
    if (host) {
      host.style.display = '';
    }
    removeReopenButton();
  }

  function clearBlurCollapse() {
    if (blurCollapseTimer) {
      clearTimeout(blurCollapseTimer);
      blurCollapseTimer = null;
    }
  }

  /** Start after the input blurs: collapse the bar if it's still unfocused when the timer fires. */
  function scheduleBlurCollapse() {
    clearBlurCollapse();
    blurCollapseTimer = setTimeout(() => {
      blurCollapseTimer = null;
      const host = document.getElementById(HOST_ID);
      if (!host || host.style.display === 'none') return;
      if (!els || !els.input) return;
      if (shadow && shadow.activeElement === els.input) return; // refocused before the timer fired
      hideFooter();
    }, BLUR_COLLAPSE_MS);
  }

  /**
   * Keyboard shortcut (relayed from background via commands API):
   * collapsed → expand + focus; expanded unfocused → focus; focused → collapse.
   */
  function toggleSpotlight() {
    const host = document.getElementById(HOST_ID);
    if (!host || !els || !els.input) return;
    const hidden = host.style.display === 'none';
    if (hidden) {
      showFooter();
      els.input.focus();
      return;
    }
    const inputFocused = shadow && shadow.activeElement === els.input;
    if (inputFocused) {
      hideFooter();
    } else {
      els.input.focus();
    }
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message && message.action === 'toggleSpotlight') {
      toggleSpotlight();
    }
  });

  function onSettingsStorageChanged(changes, areaName) {
    if (areaName !== 'local' || !changes[SETTINGS_KEY]) return;
    const ch = changes[SETTINGS_KEY];
    const prev = mergeUserSettings(ch.oldValue);
    userSettings = mergeUserSettings(ch.newValue);
    // Custom setup pages edited in the popup: rebuild the merged list live.
    if (JSON.stringify(prev.customSetupPages) !== JSON.stringify(userSettings.customSetupPages)) {
      rebuildComponents();
    }
    if (els) {
      setReadyStatus(lastCounts, components.length);
      if (els.input && normalizeQuery(els.input.value)) {
        filtered = filterComponents(els.input.value);
        renderDropdown();
      }
    }
    if (prev.defaultDisplay !== userSettings.defaultDisplay) {
      if (userSettings.defaultDisplay === 'collapsed') {
        hideFooter();
      } else {
        showFooter();
      }
    }
    const host = document.getElementById(HOST_ID);
    const barHidden = !host || host.style.display === 'none';
    if (prev.reopenButtonEnabled !== userSettings.reopenButtonEnabled) {
      if (userSettings.reopenButtonEnabled) {
        if (barHidden) showReopenButton();
      } else {
        removeReopenButton();
      }
    } else if (prev.buttonPosition !== userSettings.buttonPosition && barHidden) {
      showReopenButton();
    }
  }

  async function mount() {
    dbg('mount()', 'href', window.location.href);
    if (document.getElementById(HOST_ID)) {
      dbg('mount skipped — host already present');
      return;
    }

    userSettings = await new Promise((resolve) => {
      chrome.storage.local.get(SETTINGS_KEY, (data) => {
        if (chrome.runtime.lastError) {
          dbgWarn('storage.get settings', chrome.runtime.lastError.message);
          resolve(mergeUserSettings(null));
          return;
        }
        resolve(mergeUserSettings(data[SETTINGS_KEY]));
      });
    });

    const host = document.createElement('div');
    host.id = HOST_ID;
    document.body.appendChild(host);

    shadow = host.attachShadow({ mode: 'open' });
    loadStylesIntoShadow(shadow);

    const tpl = document.createElement('template');
    tpl.innerHTML = buildFooterHtml().trim();
    const rootNode = tpl.content.firstElementChild;
    if (!rootNode) {
      console.error('Salesforce Spotlight: failed to parse footer markup');
      return;
    }
    shadow.appendChild(rootNode);

    els = {
      root: qs(shadow, '.sfnav-root'),
      bar: qs(shadow, '.sfnav-bar'),
      input: qs(shadow, '#sfnavInput'),
      dropdown: qs(shadow, '#sfnavDropdown'),
      status: qs(shadow, '#sfnavStatus'),
      statusSummary: qs(shadow, '#sfnavStatusSummary'),
      statusCounts: qs(shadow, '#sfnavStatusCounts'),
      statusRow1: qs(shadow, '#sfnavStatusRow1'),
      statusRow2: qs(shadow, '#sfnavStatusRow2'),
      statusRow3: qs(shadow, '#sfnavStatusRow3'),
      statusRow4: qs(shadow, '#sfnavStatusRow4'),
      refresh: qs(shadow, '#sfnavRefresh'),
      close: qs(shadow, '#sfnavClose'),
    };

    els.input.addEventListener('input', onInput);
    els.input.addEventListener('keydown', onKeyDown);
    els.input.addEventListener('focus', () => {
      clearBlurCollapse();
      if (normalizeQuery(els.input.value)) {
        filtered = filterComponents(els.input.value);
        renderDropdown();
      }
    });
    els.input.addEventListener('blur', () => {
      scheduleBlurCollapse();
    });

    els.refresh.addEventListener('click', () => {
      loadComponents(true);
    });

    els.close.addEventListener('click', () => hideFooter());

    document.addEventListener(
      'click',
      (e) => {
        if (!shadow || !els || !els.dropdown || els.dropdown.hidden) return;
        const path = e.composedPath();
        if (path.includes(els.root)) return;
        els.dropdown.hidden = true;
        els.dropdown.setAttribute('aria-hidden', 'true');
        els.input.setAttribute('aria-expanded', 'false');
        els.dropdown.innerHTML = '';
        selectedIndex = -1;
      },
      true
    );

    chrome.storage.onChanged.addListener(onSettingsStorageChanged);

    if (userSettings.defaultDisplay === 'collapsed') {
      hideFooter();
    }

    loadComponents(false);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      mount();
    }, { once: true });
  } else {
    mount();
  }
})();
