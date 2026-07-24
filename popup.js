/**
 * Salesforce Spotlight — popup settings (toolbar icon).
 * Persists to chrome.storage.local under key sfnav_settings.
 *
 * Firefox MV3 treats host_permissions as optional — the user has to grant
 * them once. The banner at the top requests them via permissions.request.
 */

const SETTINGS_KEY = 'sfnav_settings';

const SF_ORIGINS = [
  'https://*.salesforce.com/*',
  'https://*.force.com/*',
  'https://*.lightning.force.com/*',
  'https://*.sandbox.lightning.force.com/*',
  'https://*.my.salesforce.com/*',
  'https://*.sandbox.my.salesforce.com/*',
  'https://*.salesforce-setup.com/*',
];

const BUTTON_POSITIONS = ['bottom-left', 'bottom-right', 'top-left', 'top-right'];

const DEFAULT_SETTINGS = {
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
  reopenButtonEnabled: true,
  buttonPosition: 'bottom-right',
  customSetupPages: [],
};

/** Working copy of the user's custom setup pages (dynamic list, not static fields). */
let customSetupPages = [];

function sanitizeCustomSetupPages(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((p) => p && typeof p.path === 'string' && p.path.startsWith('/'))
    .map((p) => ({ label: String(p.label || p.path), path: p.path }));
}

/**
 * Accept a full setup URL, an origin-relative path, or a bare node name and
 * normalize to an origin-relative setup path. Returns '' if it can't.
 */
function normalizeSetupInput(raw) {
  const v = (raw || '').trim();
  if (!v) return '';
  if (/^https?:\/\//i.test(v)) {
    try {
      const u = new URL(v);
      return (u.pathname || '') + (u.search || '');
    } catch {
      return '';
    }
  }
  if (v.startsWith('/')) return v;
  // Bare node name → standard Lightning setup home for that node.
  return `/lightning/setup/${v}/home`;
}

/** Best-effort label from a setup path, e.g. .../setup/OmniChannelSettings/home → OmniChannelSettings. */
function labelFromPath(path) {
  const m = /\/setup\/([^/?]+)/.exec(path);
  return m ? m[1] : path;
}

function mergeWithDefaults(stored) {
  const enabledTypes = { ...DEFAULT_SETTINGS.enabledTypes };
  if (stored && stored.enabledTypes && typeof stored.enabledTypes === 'object') {
    for (const k of Object.keys(DEFAULT_SETTINGS.enabledTypes)) {
      if (typeof stored.enabledTypes[k] === 'boolean') {
        enabledTypes[k] = stored.enabledTypes[k];
      }
    }
  }
  let defaultDisplay = DEFAULT_SETTINGS.defaultDisplay;
  if (stored && (stored.defaultDisplay === 'expanded' || stored.defaultDisplay === 'collapsed')) {
    defaultDisplay = stored.defaultDisplay;
  }
  let reopenButtonEnabled = DEFAULT_SETTINGS.reopenButtonEnabled;
  if (stored && typeof stored.reopenButtonEnabled === 'boolean') {
    reopenButtonEnabled = stored.reopenButtonEnabled;
  }
  let buttonPosition = DEFAULT_SETTINGS.buttonPosition;
  if (stored && BUTTON_POSITIONS.includes(stored.buttonPosition)) {
    buttonPosition = stored.buttonPosition;
  }
  const customPages = sanitizeCustomSetupPages(stored && stored.customSetupPages);
  return { enabledTypes, defaultDisplay, reopenButtonEnabled, buttonPosition, customSetupPages: customPages };
}

function getSettingsFromForm() {
  const enabledTypes = {
    Flow: Boolean(document.getElementById('typeFlow')?.checked),
    Object: Boolean(document.getElementById('typeObject')?.checked),
    LWC: Boolean(document.getElementById('typeLwc')?.checked),
    Apex: Boolean(document.getElementById('typeApex')?.checked),
    Profile: Boolean(document.getElementById('typeProfile')?.checked),
    PermSet: Boolean(document.getElementById('typePermSet')?.checked),
    PermSetGroup: Boolean(document.getElementById('typePermSetGroup')?.checked),
    Trigger: Boolean(document.getElementById('typeTrigger')?.checked),
    VFPage: Boolean(document.getElementById('typeVFPage')?.checked),
    Setup: Boolean(document.getElementById('typeSetup')?.checked),
    ObjectSetup: Boolean(document.getElementById('typeObjectSetup')?.checked),
    CMDT: Boolean(document.getElementById('typeCMDT')?.checked),
    CustomSetting: Boolean(document.getElementById('typeCustomSetting')?.checked),
    App: Boolean(document.getElementById('typeApp')?.checked),
  };
  const expanded = document.getElementById('displayExpanded');
  const defaultDisplay =
    expanded && expanded.checked ? 'expanded' : 'collapsed';
  const reopenButtonEnabled = Boolean(document.getElementById('reopenButtonToggle')?.checked);
  const positionInput = document.querySelector('input[name="buttonPosition"]:checked');
  const buttonPosition = positionInput && BUTTON_POSITIONS.includes(positionInput.value)
    ? positionInput.value
    : DEFAULT_SETTINGS.buttonPosition;
  return {
    enabledTypes,
    defaultDisplay,
    reopenButtonEnabled,
    buttonPosition,
    customSetupPages: sanitizeCustomSetupPages(customSetupPages),
  };
}

function applySettingsToForm(settings) {
  const { enabledTypes, defaultDisplay, reopenButtonEnabled, buttonPosition } = settings;
  customSetupPages = sanitizeCustomSetupPages(settings.customSetupPages);
  renderCustomSetupPages();
  const flow = document.getElementById('typeFlow');
  const object = document.getElementById('typeObject');
  const lwc = document.getElementById('typeLwc');
  const apex = document.getElementById('typeApex');
  const profile = document.getElementById('typeProfile');
  const permSet = document.getElementById('typePermSet');
  const permSetGroup = document.getElementById('typePermSetGroup');
  const trigger = document.getElementById('typeTrigger');
  const vfPage = document.getElementById('typeVFPage');
  const setup = document.getElementById('typeSetup');
  const objectSetup = document.getElementById('typeObjectSetup');
  const cmdt = document.getElementById('typeCMDT');
  const customSetting = document.getElementById('typeCustomSetting');
  const app = document.getElementById('typeApp');
  if (flow) flow.checked = enabledTypes.Flow !== false;
  if (object) object.checked = enabledTypes.Object !== false;
  if (lwc) lwc.checked = enabledTypes.LWC !== false;
  if (apex) apex.checked = enabledTypes.Apex !== false;
  if (profile) profile.checked = enabledTypes.Profile !== false;
  if (permSet) permSet.checked = enabledTypes.PermSet !== false;
  if (permSetGroup) permSetGroup.checked = enabledTypes.PermSetGroup !== false;
  if (trigger) trigger.checked = enabledTypes.Trigger !== false;
  if (vfPage) vfPage.checked = enabledTypes.VFPage !== false;
  if (setup) setup.checked = enabledTypes.Setup !== false;
  if (objectSetup) objectSetup.checked = enabledTypes.ObjectSetup !== false;
  if (cmdt) cmdt.checked = enabledTypes.CMDT !== false;
  if (customSetting) customSetting.checked = enabledTypes.CustomSetting !== false;
  if (app) app.checked = enabledTypes.App !== false;

  const expanded = document.getElementById('displayExpanded');
  const collapsed = document.getElementById('displayCollapsed');
  if (defaultDisplay === 'collapsed') {
    if (collapsed) collapsed.checked = true;
  } else {
    if (expanded) expanded.checked = true;
  }

  const reopenButtonToggle = document.getElementById('reopenButtonToggle');
  if (reopenButtonToggle) reopenButtonToggle.checked = reopenButtonEnabled !== false;

  const positionInput = document.querySelector(`input[name="buttonPosition"][value="${buttonPosition}"]`);
  if (positionInput) {
    positionInput.checked = true;
  } else {
    const fallback = document.getElementById('posBottomRight');
    if (fallback) fallback.checked = true;
  }
}

function saveSettings(settings) {
  return chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}

async function loadAndApply() {
  const data = await chrome.storage.local.get(SETTINGS_KEY);
  const raw = data[SETTINGS_KEY];
  const settings = mergeWithDefaults(raw);
  applySettingsToForm(settings);
}

function wireTypeToggles() {
  const ids = [
    'typeFlow',
    'typeObject',
    'typeLwc',
    'typeApex',
    'typeProfile',
    'typePermSet',
    'typePermSetGroup',
    'typeTrigger',
    'typeVFPage',
    'typeSetup',
    'typeObjectSetup',
    'typeCMDT',
    'typeCustomSetting',
    'typeApp',
  ];
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('change', () => {
        saveSettings(getSettingsFromForm());
      });
    }
  }
}

/* ---------- Custom setup pages ---------- */

function renderCustomSetupPages() {
  const list = document.getElementById('customPagesList');
  if (!list) return;
  list.textContent = '';
  if (customSetupPages.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'custom-empty';
    empty.textContent = 'No custom setup pages yet.';
    list.appendChild(empty);
    return;
  }
  customSetupPages.forEach((page, i) => {
    const row = document.createElement('div');
    row.className = 'custom-row';

    const text = document.createElement('div');
    text.className = 'custom-text';
    const label = document.createElement('span');
    label.className = 'custom-label';
    label.textContent = page.label;
    const path = document.createElement('span');
    path.className = 'custom-path';
    path.textContent = page.path;
    text.appendChild(label);
    text.appendChild(path);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'custom-remove';
    remove.setAttribute('aria-label', `Remove ${page.label}`);
    remove.textContent = '✕';
    remove.addEventListener('click', () => {
      customSetupPages.splice(i, 1);
      renderCustomSetupPages();
      saveSettings(getSettingsFromForm());
    });

    row.appendChild(text);
    row.appendChild(remove);
    list.appendChild(row);
  });
}

function addCustomSetupPageFromInputs() {
  const urlInput = document.getElementById('customPageUrl');
  const labelInput = document.getElementById('customPageLabel');
  const err = document.getElementById('customPageError');
  if (!urlInput) return;
  const path = normalizeSetupInput(urlInput.value);
  if (!path) {
    if (err) err.textContent = 'Enter a setup URL, a /path, or a node name.';
    return;
  }
  const label = (labelInput && labelInput.value.trim()) || labelFromPath(path);
  customSetupPages.push({ label, path });
  if (err) err.textContent = '';
  if (urlInput) urlInput.value = '';
  if (labelInput) labelInput.value = '';
  renderCustomSetupPages();
  saveSettings(getSettingsFromForm());
}

function wireCustomSetupPages() {
  const add = document.getElementById('customPageAdd');
  if (add) add.addEventListener('click', addCustomSetupPageFromInputs);
  const urlInput = document.getElementById('customPageUrl');
  if (urlInput) {
    urlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addCustomSetupPageFromInputs();
      }
    });
  }
}

function wireDisplayRadios() {
  const expanded = document.getElementById('displayExpanded');
  const collapsed = document.getElementById('displayCollapsed');
  for (const el of [expanded, collapsed]) {
    if (el) {
      el.addEventListener('change', () => {
        saveSettings(getSettingsFromForm());
      });
    }
  }
}

function wireReopenButtonToggle() {
  const el = document.getElementById('reopenButtonToggle');
  if (el) {
    el.addEventListener('change', () => {
      saveSettings(getSettingsFromForm());
    });
  }
}

function wireButtonPositionRadios() {
  const inputs = document.querySelectorAll('input[name="buttonPosition"]');
  for (const el of inputs) {
    el.addEventListener('change', () => {
      saveSettings(getSettingsFromForm());
    });
  }
}

/* ---------- Keyboard shortcut editor (Firefox commands.update) ---------- */

const COMMAND_NAME = 'toggle-spotlight';

async function loadShortcutIntoField() {
  const input = document.getElementById('shortcutInput');
  if (!input) return;
  try {
    const cmds = await chrome.commands.getAll();
    const cmd = cmds.find((c) => c.name === COMMAND_NAME);
    input.value = (cmd && cmd.shortcut) || '';
  } catch {
    input.value = '';
  }
}

/** Map KeyboardEvent.code to the commands-API key name, or null if unsupported. */
function commandKeyFromEvent(e) {
  const code = e.code || '';
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-2])$/.test(code)) return code;
  const map = {
    Space: 'Space',
    Comma: 'Comma',
    Period: 'Period',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
    Insert: 'Insert',
    Delete: 'Delete',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
  };
  return map[code] || null;
}

/** Build a commands-API shortcut string ("Ctrl+Shift+Space") from a keydown. */
function comboFromEvent(e) {
  const isMac = (navigator.platform || '').toLowerCase().includes('mac');
  const mods = [];
  if (e.ctrlKey) mods.push(isMac ? 'MacCtrl' : 'Ctrl');
  if (isMac && e.metaKey) mods.push('Command');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  const key = commandKeyFromEvent(e);
  if (!key) return null;
  // Shift alone is not enough — commands need Ctrl/Alt/Cmd.
  if (!mods.some((m) => m !== 'Shift')) return null;
  return [...mods, key].join('+');
}

function wireShortcutEditor() {
  const input = document.getElementById('shortcutInput');
  const err = document.getElementById('shortcutError');
  const reset = document.getElementById('shortcutReset');

  if (input) {
    input.addEventListener('keydown', async (e) => {
      if (e.key === 'Tab') return;
      e.preventDefault();
      e.stopPropagation();
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
      const combo = comboFromEvent(e);
      if (!combo) {
        if (err) err.textContent = 'Needs Ctrl, Alt, or Cmd plus a letter, number, or F-key.';
        return;
      }
      try {
        await chrome.commands.update({ name: COMMAND_NAME, shortcut: combo });
        input.value = combo;
        input.blur();
        if (err) err.textContent = '';
      } catch (ex) {
        if (err) err.textContent = `Firefox rejected "${combo}" — try another combination.`;
      }
    });
    input.addEventListener('focus', () => {
      if (err) err.textContent = '';
      input.value = '';
      input.placeholder = 'Press keys now…';
    });
    input.addEventListener('blur', () => {
      input.placeholder = 'Click, then press keys…';
      loadShortcutIntoField();
    });
  }

  if (reset) {
    reset.addEventListener('click', async () => {
      try {
        await chrome.commands.reset(COMMAND_NAME);
      } catch {
        /* ignore */
      }
      if (err) err.textContent = '';
      loadShortcutIntoField();
    });
  }
}

async function refreshPermissionBanner() {
  const banner = document.getElementById('permBanner');
  if (!banner) return;
  try {
    const granted = await chrome.permissions.contains({ origins: SF_ORIGINS });
    banner.classList.toggle('visible', !granted);
  } catch {
    banner.classList.remove('visible');
  }
}

function wirePermissionGrant() {
  const btn = document.getElementById('permGrantBtn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    try {
      await chrome.permissions.request({ origins: SF_ORIGINS });
    } catch {
      /* user dismissed or request failed — banner stays */
    }
    refreshPermissionBanner();
  });
}

document.addEventListener('DOMContentLoaded', () => {
  loadAndApply().catch(() => {
    applySettingsToForm(DEFAULT_SETTINGS);
  });
  wireTypeToggles();
  wireCustomSetupPages();
  wireDisplayRadios();
  wireReopenButtonToggle();
  wireButtonPositionRadios();
  wirePermissionGrant();
  refreshPermissionBanner();
  wireShortcutEditor();
  loadShortcutIntoField();
});
