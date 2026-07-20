# Salesforce Spotlight

**Firefox extension** (Manifest V3) that adds a **Salesforce Spotlight** bar on Lightning and classic Salesforce domains. It loads metadata from your org (REST and Tooling APIs)-flows, objects, LWC bundles, Apex classes, **profiles**, **permission sets**, **permission set groups**, **Apex triggers**, **Visualforce pages**-plus **setup pages** (Deployment Status, Object Manager, Users, Debug Logs, and ~60 more) and **Object Manager deep links** (e.g. *Account › Fields & Relationships*), and lets you **search** with fuzzy multi-word matching. You can type a **component kind** as a keyword (for example **profile API access** to find a profile named "API Access", or **account validation** to jump to Account validation rules). Results **open** the matching page in a new tab.

> This is a fork from znAaron's Chrome extension. For the Chrome extension, check out their repository here: https://github.com/znAaron/SalesforceSpotlight

## Requirements

- **Firefox 140+** (regular Firefox for temporary install; **Developer Edition**, **Nightly**, or **ESR** for permanent unsigned install)
- You must be **logged into Salesforce** in the same browser; the extension uses your **My Domain** session cookie for API calls.

## Build the xpi

```bash
./build.sh
```

This produces `dist/salesforce_spotlight-<version>.xpi`.

## Install

### Option A - Temporary (any Firefox, resets on browser restart)

1. Open **`about:debugging#/runtime/this-firefox`**.
2. Click **Load Temporary Add-on…**.
3. Select the built **xpi** (or `manifest.json` in the repo folder).

### Option B - Permanent unsigned (Developer Edition / Nightly / ESR)

1. Open **`about:config`** and set **`xpinstall.signatures.required`** to **`false`**. (Regular Firefox ignores this switch; use Developer Edition, Nightly, or ESR.)
2. Open **`about:addons`** → gear icon → **Install Add-on From File…** → select the xpi.

### Grant Salesforce access (important!)

Firefox MV3 treats host permissions as **optional**. Without the grant, the Spotlight bar will not appear on Salesforce pages.

- Click the **Salesforce Spotlight** toolbar icon - if access is missing, the popup shows a **"Grant access to Salesforce"** button. Click it and accept.
- Alternatively: **`about:addons`** → Salesforce Spotlight → **Permissions** tab → enable access to the Salesforce domains.

## Usage

- Open any matching Salesforce URL (production, sandbox, Lightning, or My Domain).
- **Keyboard shortcut:** press **Ctrl+Shift+Space** (same on macOS - the real Ctrl key, not Cmd) to open the Spotlight bar and focus the search field. Press again (or **Esc** in the search box) to hide it. Change the binding directly in the **extension popup** (Keyboard shortcut section), or under `about:addons` → gear ⚙ → Manage Extension Shortcuts.
- **Reopen button:** while the bar is hidden, a small floating **Spotlight** button appears on the page - click it to bring the bar back without using the shortcut. It's on by default; turn it off in the popup (**Reopen button** section) if you'd rather rely on the shortcut only, and pick which screen corner it appears in (top left, top right, bottom left, bottom right).
- **Toolbar settings:** click the extension icon to open the popup. **Default on page load** lets you choose **expanded** (full search bar) or **collapsed** (hidden until reopened). Below that, **search component types** lists every category - including **Setup** (setup pages) and **Obj setup** (Object Manager deep links) types. **All types are enabled by default**; turn off any you want to exclude. Settings apply to Salesforce tabs immediately (including tabs that are already open).
- By default, new installs start with the bar **collapsed**; click the reopen button to expand the full spotlight bar.
- **Search:** every word you type must appear somewhere in the match (multi-token filter). Type keywords work too:
  - `deployment` → **Deployment Status** setup page
  - `account fields` → **Account › Fields & Relationships** in Object Manager
  - `profile api access` → profile named "API Access"
  - Setup pages also match common **German** terms (e.g. `benutzer` → Users, `validierungsregeln` → validation rules).
- Choose a result to open it in a new tab.
- Use **Refresh** on the bar to reload metadata from the org (results are cached for 10 minutes).
- Use **Close** on the bar to hide it and show the reopen button again.

## Privacy & security

- The extension reads Salesforce **`sid`** cookies only for allowed Salesforce domains and uses them only to call Salesforce APIs from the extension's background script.
- No third-party servers; data stays between your browser and your Salesforce org.

## Version

**2.6.0** (Jul 2026). The authoritative version is in `manifest.json`.

- **2.6.0** - Reopen button is back (click to reopen instead of the shortcut only), now optional via a checkbox in the popup and positionable in any of the four screen corners; version number removed from the bar itself.
- **2.3.0** - Shortcut editable in the popup (`commands.update`); reopen pill removed (shortcut-only); Esc hides the bar.
- **2.2.x** - CMDT direct links (Open + Manage Records) via the classic setup domain; ManageUsersLightning; index counts auto-hide after load; container cookie-store support (Zen workspaces); `*.my.salesforce-setup.com` domain support.

- **2.1.0** - Keyboard shortcut **Ctrl+Shift+Space** (also Ctrl on macOS, not Cmd) to toggle/focus the Spotlight bar; rebindable via Manage Extension Shortcuts.
- **2.0.0** - Ported from Chrome to **Firefox** (MV3 event page, `browser_specific_settings.gecko`, Total-Cookie-Protection-safe cookie lookup, host-permission grant flow in the popup). Added **setup page search** (~60 curated pages, English + German keywords) and **Object Manager deep links** (Fields & Relationships, Record Types, Validation Rules, Page Layouts, Lightning Record Pages, Buttons/Links/Actions per object). Added `build.sh` to produce the xpi.
- **1.4.0** - last Chrome version: profiles, permission sets/groups, triggers, VF pages, type keywords, settings layout.

## Maintainers

- Bump `version` in `manifest.json`, run `./build.sh`, attach the xpi from `dist/` to a GitHub release.
- Lint before release: `npx web-ext lint --source-dir . --ignore-files 'dist/**' 'build.sh' 'content.css' 'README.md'`
- For distribution in **regular Firefox**, the xpi must be **signed** via [addons.mozilla.org](https://addons.mozilla.org) (listed or unlisted/self-distributed). `web-ext sign` with AMO API keys handles the unlisted flow.

## License

MIT
