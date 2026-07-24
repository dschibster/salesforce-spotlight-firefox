/**
 * Salesforce Spotlight — background script (Firefox MV3 event page).
 *
 * Key: Lightning (*.lightning.force.com) and My Domain (*.my.salesforce.com)
 * have DIFFERENT session IDs. REST API only works with the My Domain sid.
 * We read the sid cookie from the My Domain origin and use Bearer auth.
 *
 * Firefox note: chrome.* namespace works in Firefox MV3 (incl. promises).
 * Cookie calls pass firstPartyDomain: null so cookies partitioned by
 * Total Cookie Protection (dFPI) are found too.
 */

const SFNAV_DEBUG = true;

function dbg(...args) {
  if (SFNAV_DEBUG) console.log('[Spotlight BG]', ...args);
}
function dbgWarn(...args) {
  if (SFNAV_DEBUG) console.warn('[Spotlight BG]', ...args);
}
function sidHint(sid) {
  if (!sid) return '(none)';
  return `${String(sid).slice(0, 8)}…(len ${String(sid).length})`;
}

const CACHE_TTL_MS = 60 * 60 * 1000;
// Bump this whenever the built component schema changes (new item types/links),
// so an updated build ignores caches written by an older one instead of serving
// a stale list until TTL — storage.local survives reinstalls (stable add-on id).
const CACHE_PREFIX = 'sfnav_v16_';
const API_VERSIONS = ['v66.0', 'v65.0', 'v64.0', 'v63.0', 'v62.0', 'v61.0', 'v60.0'];

function resolveMyDomainOrigin(tabUrl) {
  try {
    const host = new URL(tabUrl).hostname;
    if (host.endsWith('.sandbox.lightning.force.com')) {
      const prefix = host.slice(0, -'.sandbox.lightning.force.com'.length);
      return `https://${prefix}.sandbox.my.salesforce.com`;
    }
    if (host.endsWith('.lightning.force.com')) {
      const prefix = host.slice(0, -'.lightning.force.com'.length);
      return `https://${prefix}.my.salesforce.com`;
    }
    // Enhanced domains: Setup pages live on *.my.salesforce-setup.com
    if (host.endsWith('.sandbox.my.salesforce-setup.com')) {
      const prefix = host.slice(0, -'.sandbox.my.salesforce-setup.com'.length);
      return `https://${prefix}.sandbox.my.salesforce.com`;
    }
    if (host.endsWith('.my.salesforce-setup.com')) {
      const prefix = host.slice(0, -'.my.salesforce-setup.com'.length);
      return `https://${prefix}.my.salesforce.com`;
    }
    return new URL(tabUrl).origin.replace(/\/$/, '');
  } catch {
    return '';
  }
}

function resolveUiOrigin(tabUrl) {
  try {
    const host = new URL(tabUrl).hostname;
    // Build result links on the Lightning domain, even when browsing Setup
    // on the salesforce-setup.com domain.
    if (host.endsWith('.sandbox.my.salesforce-setup.com')) {
      const prefix = host.slice(0, -'.sandbox.my.salesforce-setup.com'.length);
      return `https://${prefix}.sandbox.lightning.force.com`;
    }
    if (host.endsWith('.my.salesforce-setup.com')) {
      const prefix = host.slice(0, -'.my.salesforce-setup.com'.length);
      return `https://${prefix}.lightning.force.com`;
    }
    return new URL(tabUrl).origin.replace(/\/$/, '');
  } catch {
    return '';
  }
}

/**
 * Enhanced domains: classic setup pages moved off my.salesforce.com onto
 * *.my.salesforce-setup.com ("URL no longer exists" otherwise). Top-level
 * navigation there is first-party, so the auth handshake works even with
 * strict cookie blocking.
 */
function classicSetupOrigin(apiBase) {
  try {
    const host = new URL(apiBase).hostname;
    if (host.endsWith('.sandbox.my.salesforce.com')) {
      return `https://${host.slice(0, -'.sandbox.my.salesforce.com'.length)}.sandbox.my.salesforce-setup.com`;
    }
    if (host.endsWith('.my.salesforce.com')) {
      return `https://${host.slice(0, -'.my.salesforce.com'.length)}.my.salesforce-setup.com`;
    }
    return apiBase.replace(/\/$/, '');
  } catch {
    return apiBase;
  }
}

function firstDefined(obj, keys) {
  for (const k of keys) {
    const v = obj[k];
    if (v != null && v !== '') return v;
  }
  return '';
}

function cacheKey(host) {
  return `${CACHE_PREFIX}${host}`;
}

/**
 * Org-level cache host: collapse Lightning, Setup and My Domain hosts of the
 * same org to one key (the canonical *.my.salesforce.com host), so the metadata
 * cache and sticky choices are shared instead of split per subdomain.
 */
function orgCacheHost(tabUrl) {
  const origin = resolveMyDomainOrigin(tabUrl);
  try {
    return origin ? new URL(origin).host : new URL(tabUrl).host;
  } catch {
    return '';
  }
}

/**
 * Words users can type to narrow by component type (e.g. "profile API access" finds profile "API Access").
 * Appended to every item's searchText; filter uses multi-token AND on this haystack.
 */
const TYPE_SEARCH_KEYWORDS = {
  Flow: 'flow',
  Object: 'object',
  LWC: 'lwc lightning web component',
  Apex: 'apex class',
  Profile: 'profile',
  PermSet: 'permission set permset perm set',
  PermSetGroup: 'permission set group permsetgroup perm set group psg',
  Trigger: 'trigger apex trigger',
  VFPage: 'visualforce vf page vfpage',
  Setup: 'setup',
  ObjectSetup: 'object setup manager',
  CMDT: 'cmdt custom metadata type',
  CustomSetting: 'custom setting hierarchy list settings',
  App: 'app application anwendung launcher',
};

/**
 * Static setup pages. `path` is appended to the UI origin.
 * `kw` holds extra search aliases (English + common German terms).
 */
const SETUP_PAGES = [
  { label: 'Setup Home', path: '/lightning/setup/SetupOneHome/home', kw: 'home start' },
  { label: 'Object Manager', path: '/lightning/setup/ObjectManager/home', kw: 'objekt objects' },
  { label: 'Deployment Status', path: '/lightning/setup/DeployStatus/home', kw: 'deploy deployments bereitstellung' },
  { label: 'Flows', path: '/lightning/setup/Flows/home', kw: 'flow list all flows' },
  // No queryable flag exposes whether the org's Enhanced User List View is on,
  // so ship both: the enhanced Lightning page as primary, the classic list as a
  // lower-ranked fallback. Once the user opens one, its `choiceGroup` makes it
  // stick per host (only the picked variant shows) until the cache is flushed.
  { label: 'Users', path: '/lightning/setup/ManageUsersLightning/home', kw: 'user benutzer manage users enhanced', choiceGroup: 'users', choiceVariant: 'lightning' },
  // No rank bump: it would sink below unrelated "…Users" permission-set-group
  // matches and fall past the result cap. Equal rank keeps both Users entries
  // together at the top (enhanced first via name tie-break).
  { label: 'Users (Classic list)', path: '/lightning/setup/ManageUsers/home', kw: 'user benutzer manage users classic', choiceGroup: 'users', choiceVariant: 'classic' },
  { label: 'Profiles', path: '/lightning/setup/EnhancedProfiles/home', kw: 'profile profil' },
  { label: 'Permission Sets', path: '/lightning/setup/PermSets/home', kw: 'permset berechtigungssatz' },
  { label: 'Permission Set Groups', path: '/lightning/setup/PermSetGroups/home', kw: 'psg berechtigungssatzgruppe' },
  { label: 'Public Groups', path: '/lightning/setup/PublicGroups/home', kw: 'group gruppe' },
  { label: 'Queues', path: '/lightning/setup/Queues/home', kw: 'queue warteschlange' },
  { label: 'Roles', path: '/lightning/setup/Roles/home', kw: 'role rolle hierarchy' },
  { label: 'Company Information', path: '/lightning/setup/CompanyProfileInfo/home', kw: 'org id licenses lizenzen firmeninformationen' },
  { label: 'Business Hours', path: '/lightning/setup/BusinessHours/home', kw: 'geschäftszeiten' },
  { label: 'Apex Classes', path: '/lightning/setup/ApexClasses/home', kw: 'apex class list' },
  { label: 'Apex Triggers', path: '/lightning/setup/ApexTriggers/home', kw: 'trigger list' },
  { label: 'Apex Test Execution', path: '/lightning/setup/ApexTestQueue/home', kw: 'test run tests' },
  { label: 'Apex Jobs', path: '/lightning/setup/AsyncApexJobs/home', kw: 'batch async jobs' },
  { label: 'Scheduled Jobs', path: '/lightning/setup/ScheduledJobs/home', kw: 'cron schedule geplante jobs' },
  { label: 'Debug Logs', path: '/lightning/setup/ApexDebugLogs/home', kw: 'logs trace debugging' },
  { label: 'Email Deliverability', path: '/lightning/setup/OrgEmailSettings/home', kw: 'email access level zustellbarkeit' },
  { label: 'Classic Email Templates', path: '/lightning/setup/CommunicationTemplatesEmail/home', kw: 'email template vorlage' },
  { label: 'Custom Labels', path: '/lightning/setup/ExternalStrings/home', kw: 'label benutzerdefinierte bezeichnungen' },
  { label: 'Custom Metadata Types', path: '/lightning/setup/CustomMetadata/home', kw: 'cmdt metadata' },
  { label: 'Custom Settings', path: '/lightning/setup/CustomSettings/home', kw: 'hierarchy list settings' },
  { label: 'Custom Permissions', path: '/lightning/setup/CustomPermissions/home', kw: 'permission' },
  { label: 'Static Resources', path: '/lightning/setup/StaticResources/home', kw: 'resource statisch' },
  { label: 'Named Credentials', path: '/lightning/setup/NamedCredential/home', kw: 'credential endpoint' },
  { label: 'Auth. Providers', path: '/lightning/setup/AuthProviders/home', kw: 'authentication oauth provider' },
  { label: 'Remote Site Settings', path: '/lightning/setup/SecurityRemoteProxy/home', kw: 'remote site callout' },
  { label: 'CORS', path: '/lightning/setup/CorsWhitelistEntries/home', kw: 'cross origin allowlist' },
  { label: 'Connected Apps', path: '/lightning/setup/ConnectedApplication/home', kw: 'oauth app manage' },
  { label: 'App Manager', path: '/lightning/setup/NavigationMenus/home', kw: 'apps lightning app anwendungsmanager' },
  { label: 'External Services', path: '/lightning/setup/ExternalServices/home', kw: 'openapi registration' },
  { label: 'Sharing Settings', path: '/lightning/setup/SecuritySharing/home', kw: 'owd org wide defaults sharing rules freigabe' },
  { label: 'Login History', path: '/lightning/setup/OrgLoginHistory/home', kw: 'login anmeldeverlauf' },
  { label: 'Setup Audit Trail', path: '/lightning/setup/SecurityEvents/home', kw: 'audit history änderungsprotokoll' },
  { label: 'Session Settings', path: '/lightning/setup/SecuritySession/home', kw: 'session timeout sitzung' },
  { label: 'Password Policies', path: '/lightning/setup/SecurityPolicies/home', kw: 'password kennwort richtlinien' },
  { label: 'Health Check', path: '/lightning/setup/HealthCheck/home', kw: 'security zustandsprüfung' },
  { label: 'Storage Usage', path: '/lightning/setup/CompanyResourceDisk/home', kw: 'storage speicher data usage' },
  { label: 'Data Export', path: '/lightning/setup/DataManagementExport/home', kw: 'export backup datenexport' },
  { label: 'Data Import Wizard', path: '/lightning/setup/DataManagementDataImporter/home', kw: 'import datenimport' },
  { label: 'Mass Delete Records', path: '/lightning/setup/DataManagementDelete/home', kw: 'delete massenlöschung' },
  { label: 'Sandboxes', path: '/lightning/setup/DataManagementCreateTestInstance/home', kw: 'sandbox refresh' },
  { label: 'Outbound Change Sets', path: '/lightning/setup/OutboundChangeSet/home', kw: 'changeset deploy' },
  { label: 'Inbound Change Sets', path: '/lightning/setup/InboundChangeSet/home', kw: 'changeset validate' },
  { label: 'Installed Packages', path: '/lightning/setup/ImportedPackage/home', kw: 'package managed installierte pakete' },
  { label: 'Tabs', path: '/lightning/setup/CustomTabs/home', kw: 'tab registerkarten' },
  { label: 'Translation Workbench', path: '/lightning/setup/LabelWorkbenchTranslate/home', kw: 'translate übersetzung' },
  { label: 'Process Automation Settings', path: '/lightning/setup/ProcessAutomationSettings/home', kw: 'flow automation settings' },
  { label: 'Lightning App Builder', path: '/lightning/setup/FlexiPageList/home', kw: 'flexipage record page' },
  { label: 'Picklist Value Sets', path: '/lightning/setup/Picklists/home', kw: 'global picklist auswahlliste' },
  { label: 'Digital Experiences — All Sites', path: '/lightning/setup/SetupNetworks/home', kw: 'community experience cloud sites' },
  { label: 'User Interface', path: '/lightning/setup/UserInterfaceUI/home', kw: 'ui settings benutzeroberfläche' },
  { label: 'Themes and Branding', path: '/lightning/setup/ThemingAndBranding/home', kw: 'theme branding design' },
  { label: 'My Domain', path: '/lightning/setup/OrgDomain/home', kw: 'domain url' },
  { label: 'Single Sign-On Settings', path: '/lightning/setup/SingleSignOn/home', kw: 'sso saml' },
  { label: 'Certificate and Key Management', path: '/lightning/setup/CertificatesAndKeysManagement/home', kw: 'certificate zertifikat keys' },
  { label: 'Duplicate Rules', path: '/lightning/setup/DuplicateRules/home', kw: 'duplicate dublette' },
  { label: 'Matching Rules', path: '/lightning/setup/MatchingRules/home', kw: 'matching dublette' },
  { label: 'Approval Processes', path: '/lightning/setup/ApprovalProcesses/home', kw: 'approval genehmigung' },
  { label: 'Workflow Rules', path: '/lightning/setup/WorkflowRules/home', kw: 'workflow regel' },
  { label: 'Big Objects', path: '/lightning/setup/BigObjects/home', kw: 'big object' },
];

/**
 * Object Manager sub-pages generated per queryable sobject.
 * `node` is the ObjectManager URL segment, `kw` extra search words.
 */
const OBJECT_SETUP_SUBPAGES = [
  { suffix: 'Fields & Relationships', node: 'FieldsAndRelationships', kw: 'fields felder relationships' },
  { suffix: 'Record Types', node: 'RecordTypes', kw: 'record types datensatztypen' },
  { suffix: 'Validation Rules', node: 'ValidationRules', kw: 'validation rules validierungsregeln' },
  { suffix: 'Page Layouts', node: 'PageLayouts', kw: 'page layouts seitenlayouts' },
  { suffix: 'Lightning Record Pages', node: 'LightningPages', kw: 'lightning record pages flexipage' },
  { suffix: 'Buttons, Links, and Actions', node: 'ButtonsLinksActions', kw: 'buttons links actions schaltflächen' },
];

/**
 * @param {string} type
 * @param {string} base - name/label fragments (any case)
 */
function searchTextWithTypeKeywords(type, base) {
  const kw = TYPE_SEARCH_KEYWORDS[type] || '';
  const combined = `${base} ${kw}`.trim();
  return combined.toLowerCase().replace(/\s+/g, ' ');
}

/**
 * cookies.getAll with progressively simpler params. Firefox needs
 * firstPartyDomain: null (First-Party Isolation) and partitionKey: {}
 * (Total Cookie Protection) to see every cookie jar — but older versions
 * reject unknown params, so fall back gracefully.
 */
async function getSidCookies(details, storeIds) {
  const variants = [
    { ...details, firstPartyDomain: null, partitionKey: {} },
    { ...details, firstPartyDomain: null },
    { ...details },
  ];
  for (const storeId of storeIds) {
    for (const v of variants) {
      const d = storeId ? { ...v, storeId } : v;
      try {
        const list = await chrome.cookies.getAll(d);
        if (list && list.length) {
          dbg('cookies found', { storeId: storeId || '(default)', params: Object.keys(d).join(','), count: list.length });
          return list;
        }
      } catch (e) {
        dbgWarn('cookies.getAll variant failed', storeId || '(default)', JSON.stringify(Object.keys(d)), e);
      }
    }
  }
  return [];
}

/**
 * Container tabs (Firefox Multi-Account Containers, Zen workspaces, private
 * windows) keep cookies in separate stores. The background's default store
 * often is NOT where the Salesforce session lives — so search the tab's own
 * store first, then the default, then every other store.
 */
async function candidateStoreIds(tabStoreId) {
  const ids = [];
  if (tabStoreId) ids.push(tabStoreId);
  ids.push(undefined); // background context's default store
  try {
    const stores = await chrome.cookies.getAllCookieStores();
    dbg('cookie stores:', stores.map((s) => s && s.id));
    for (const s of stores) {
      if (s && s.id && !ids.includes(s.id)) ids.push(s.id);
    }
  } catch (e) {
    dbgWarn('getAllCookieStores failed', e);
  }
  return ids;
}

/**
 * Read the sid cookie from My Domain (the one that works for REST API).
 * Lightning sid does NOT work — it's a different session.
 */
async function getMyDomainSession(tabUrl, tabStoreId) {
  const myDomainOrigin = resolveMyDomainOrigin(tabUrl);
  const uiOrigin = resolveUiOrigin(tabUrl);

  dbg('resolving session', { uiOrigin, myDomainOrigin, tabStoreId });
  const storeIds = await candidateStoreIds(tabStoreId);

  if (myDomainOrigin) {
    const list = await getSidCookies({ url: `${myDomainOrigin}/`, name: 'sid' }, storeIds);
    const c = list.find((x) => x && x.value);
    if (c) {
      dbg('sid from My Domain ✓', { origin: myDomainOrigin, sid: sidHint(c.value) });
      return { sid: c.value.trim(), apiBase: myDomainOrigin, uiOrigin };
    }
    dbg('no sid cookie on My Domain', myDomainOrigin);
  }

  dbg('scanning all sid cookies...');
  try {
    const all = await getSidCookies({ name: 'sid' }, storeIds);
    dbg('total sid cookies:', all.length);
    for (const c of all) {
      const d = (c.domain || '').toLowerCase();
      dbg('  cookie domain:', d, 'sid:', sidHint(c.value));
    }
    for (const c of all) {
      const d = (c.domain || '').toLowerCase();
      if (d.includes('.my.salesforce.com') || d.includes('.sandbox.my.salesforce.com')) {
        const host = d.startsWith('.') ? d.slice(1) : d;
        const origin = `https://${host}`;
        dbg('sid from cookie scan (My Domain) ✓', { domain: d, sid: sidHint(c.value) });
        return { sid: c.value.trim(), apiBase: origin, uiOrigin };
      }
    }
    for (const c of all) {
      const d = (c.domain || '').toLowerCase();
      if (d.includes('salesforce.com') && !d.includes('lightning')) {
        const host = d.startsWith('.') ? d.slice(1) : d;
        const origin = `https://${host}`;
        dbg('sid from cookie scan (salesforce.com fallback) ✓', { domain: d, sid: sidHint(c.value) });
        return { sid: c.value.trim(), apiBase: origin, uiOrigin };
      }
    }
  } catch (e) {
    dbgWarn('cookies.getAll error', e);
  }

  dbgWarn('no usable sid cookie found');
  return null;
}

async function sfdcFetch(url, sid) {
  return fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${sid}`,
      Accept: 'application/json',
    },
  });
}

async function findApiVersion(apiBase, sid) {
  for (const ver of API_VERSIONS) {
    const url = `${apiBase}/services/data/${ver}/limits`;
    const res = await sfdcFetch(url, sid);
    if (res.ok) {
      dbg('API version OK:', ver, 'on', apiBase);
      return ver;
    }
    if (res.status === 401 || res.status === 403) {
      const text = await res.text().catch(() => '');
      dbgWarn('Bearer rejected on', apiBase, res.status, text.slice(0, 120));
      return null;
    }
  }
  return null;
}

async function soqlQuery(apiBase, sid, apiVersion, soql, label, tooling) {
  const records = [];
  const endpoint = tooling ? 'tooling/query' : 'query';
  let path = `/services/data/${apiVersion}/${endpoint}?q=${encodeURIComponent(soql)}`;
  while (path) {
    const url = path.startsWith('http') ? path : `${apiBase}${path}`;
    const res = await sfdcFetch(url, sid);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      dbgWarn(`${label} HTTP ${res.status}`, text.slice(0, 160));
      throw new Error(`${label} ${res.status}: ${text.slice(0, 200)}`);
    }
    const body = await res.json();
    if (Array.isArray(body.records)) records.push(...body.records);
    path = body.nextRecordsUrl
      ? (body.nextRecordsUrl.startsWith('http') ? body.nextRecordsUrl : `${apiBase}${body.nextRecordsUrl}`)
      : null;
  }
  dbg(`${label}:`, records.length, 'records');
  return records;
}

async function fetchSobjects(apiBase, sid, apiVersion) {
  const url = `${apiBase}/services/data/${apiVersion}/sobjects/`;
  const res = await sfdcFetch(url, sid);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`sobjects ${res.status}: ${text.slice(0, 200)}`);
  }
  const body = await res.json();
  const list = Array.isArray(body.sobjects) ? body.sobjects : [];
  dbg('sobjects:', list.length);
  return list;
}

function buildComponentList(
  uiOrigin,
  apiBase,
  flows,
  sobjects,
  lwcs,
  apexes,
  profiles,
  permSets,
  permSetGroups,
  triggers,
  vfPages,
  customObjects,
  apps
) {
  const items = [];
  const o = uiOrigin.replace(/\/$/, '');
  // Classic setup pages linked top-level on the setup domain — avoids both
  // the cross-domain-iframe dead end (Lightning wrapper) and the
  // "URL no longer exists" page (my.salesforce.com no longer serves setup).
  const my = classicSetupOrigin(apiBase || o);

  // CMDT and Custom Setting setup links need the CustomObject Id (01I…) from
  // the Tooling API, matched to the describeGlobal name. The Tooling row holds
  // the base DeveloperName (no __mdt/__c suffix), so key on ns__Dev and strip
  // the suffix at lookup time.
  const coIdByBaseName = new Map();
  for (const co of customObjects) {
    const dev = firstDefined(co, ['DeveloperName', 'developerName']);
    const ns = firstDefined(co, ['NamespacePrefix', 'namespacePrefix']);
    const id = firstDefined(co, ['Id', 'id']);
    if (!dev || !id) continue;
    coIdByBaseName.set(`${ns ? `${ns}__` : ''}${dev}`.toLowerCase(), id);
  }

  for (const f of flows) {
    const label = firstDefined(f, ['Label', 'label']) || firstDefined(f, ['ApiName', 'apiName']) || 'Flow';
    const apiName = firstDefined(f, ['ApiName', 'apiName']);
    const id = firstDefined(f, ['Id', 'id']);
    if (!id) continue;
    const avId = firstDefined(f, ['ActiveVersionId', 'activeVersionId']);
    const pt = firstDefined(f, ['ProcessType', 'processType']);
    const name = apiName ? `${label} (${apiName})` : label;
    items.push({
      type: 'Flow', name,
      searchText: searchTextWithTypeKeywords('Flow', `${label} ${apiName} ${pt}`),
      url: avId
        ? `${o}/builder_platform_interaction/flowBuilder.app?flowId=${encodeURIComponent(avId)}`
        : `${o}/lightning/setup/Flows/page?address=%2F${encodeURIComponent(id)}`,
    });
  }
  for (const s of sobjects) {
    const apiName = s.name || s.Name;
    if (!apiName) continue;
    const label = s.label || s.Label || apiName;
    // Custom metadata types: direct "open" + "manage records" setup links
    // instead of an (unusable) Object Manager entry.
    if (apiName.endsWith('__mdt')) {
      const mdtId = coIdByBaseName.get(apiName.replace(/__mdt$/i, '').toLowerCase());
      const keyPrefix = s.keyPrefix || s.KeyPrefix;
      if (mdtId) {
        items.push({
          type: 'CMDT',
          name: `${label} — Open (${apiName})`,
          searchText: searchTextWithTypeKeywords('CMDT', `${label} ${apiName} open`),
          url: `${my}/${mdtId}?setupid=CustomMetadata`,
        });
      }
      // Classic lists an entity's records under its key prefix (m0X…) —
      // the reliable "Manage Records" target.
      if (keyPrefix) {
        items.push({
          type: 'CMDT',
          name: `${label} — Manage Records (${apiName})`,
          searchText: searchTextWithTypeKeywords('CMDT', `${label} ${apiName} manage records`),
          url: `${my}/${keyPrefix}?setupid=CustomMetadata`,
        });
      }
      continue;
    }
    // Custom settings: like CMDT, the Object Manager entry is a dead end.
    // Offer a direct "open" (definition) plus the classic data-management page.
    if (s.customSetting) {
      const coId = coIdByBaseName.get(apiName.replace(/__c$/i, '').toLowerCase());
      const keyPrefix = s.keyPrefix || s.KeyPrefix;
      if (coId) {
        items.push({
          type: 'CustomSetting',
          name: `${label} — Open (${apiName})`,
          searchText: searchTextWithTypeKeywords('CustomSetting', `${label} ${apiName} open`),
          url: `${my}/${coId}?setupid=CustomSettings`,
        });
      }
      // Manage data page wants the entity KEY PREFIX as its id (not the Tooling
      // object id, which it rejects as "Invalid Custom Setting id"). The extra
      // ViewState params in the org's own "Manage" link are postback noise; a
      // plain GET with id + setupid renders the same data view.
      if (keyPrefix) {
        items.push({
          type: 'CustomSetting',
          name: `${label} — Manage Records (${apiName})`,
          searchText: searchTextWithTypeKeywords('CustomSetting', `${label} ${apiName} manage records`),
          url: `${my}/setup/ui/listCustomSettingsData.apexp?id=${encodeURIComponent(keyPrefix)}&setupid=CustomSettings`,
        });
      }
      continue;
    }
    if (!s.retrieveable || apiName.endsWith('__ChangeEvent')) continue;
    items.push({
      type: 'Object',
      name: `${label} (${apiName})`,
      searchText: searchTextWithTypeKeywords('Object', `${label} ${apiName}`),
      url: `${o}/lightning/setup/ObjectManager/${encodeURIComponent(apiName)}/Details/view`,
    });
    // Object Manager deep links — only for real setup-manageable objects.
    for (const sub of OBJECT_SETUP_SUBPAGES) {
      items.push({
        type: 'ObjectSetup',
        name: `${label} › ${sub.suffix}`,
        searchText: searchTextWithTypeKeywords('ObjectSetup', `${label} ${apiName} ${sub.kw}`),
        url: `${o}/lightning/setup/ObjectManager/${encodeURIComponent(apiName)}/${sub.node}/view`,
        rank: 1,
      });
    }
  }
  for (const sp of SETUP_PAGES) {
    const item = {
      type: 'Setup',
      name: sp.label,
      searchText: searchTextWithTypeKeywords('Setup', `${sp.label} ${sp.kw}`),
      url: `${o}${sp.path}`,
      rank: sp.rank || 0,
    };
    if (sp.choiceGroup) {
      item.choiceGroup = sp.choiceGroup;
      item.choiceVariant = sp.choiceVariant;
    }
    items.push(item);
  }
  for (const a of apps) {
    const durableId = firstDefined(a, ['DurableId', 'durableId']);
    const label = firstDefined(a, ['Label', 'label']);
    const dev = firstDefined(a, ['DeveloperName', 'developerName']);
    if (!durableId || !label) continue;
    const display = dev && dev !== label ? `${label} (${dev})` : label;
    items.push({
      type: 'App',
      name: display,
      searchText: searchTextWithTypeKeywords('App', `${label} ${dev}`),
      url: `${o}/lightning/app/${encodeURIComponent(durableId)}`,
    });
  }
  for (const b of lwcs) {
    const dev = firstDefined(b, ['DeveloperName', 'developerName']) || firstDefined(b, ['MasterLabel', 'masterLabel']) || 'LWC';
    const label = firstDefined(b, ['MasterLabel', 'masterLabel']) || dev;
    const id = firstDefined(b, ['Id', 'id']);
    if (!id) continue;
    const name = label !== dev ? `${label} (${dev})` : dev;
    items.push({
      type: 'LWC', name,
      searchText: searchTextWithTypeKeywords('LWC', `${label} ${dev}`),
      url: `${o}/lightning/setup/LightningComponentBundles/page?address=%2F${id}`,
    });
  }
  for (const a of apexes) {
    const n = firstDefined(a, ['Name', 'name']);
    const id = firstDefined(a, ['Id', 'id']);
    if (!n || !id) continue;
    items.push({
      type: 'Apex', name: n,
      searchText: searchTextWithTypeKeywords('Apex', n),
      url: `${o}/lightning/setup/ApexClasses/page?address=%2F${id}`,
    });
  }
  for (const p of profiles) {
    const n = firstDefined(p, ['Name', 'name']);
    const id = firstDefined(p, ['Id', 'id']);
    if (!n || !id) continue;
    items.push({
      type: 'Profile', name: n,
      searchText: searchTextWithTypeKeywords('Profile', n),
      url: `${o}/lightning/setup/EnhancedProfiles/page?address=%2F${encodeURIComponent(id)}`,
    });
  }
  for (const ps of permSets) {
    const name = firstDefined(ps, ['Name', 'name']);
    const label = firstDefined(ps, ['Label', 'label']) || name;
    const id = firstDefined(ps, ['Id', 'id']);
    if (!id) continue;
    const display = label && name && label !== name ? `${label} (${name})` : (label || name || 'Permission Set');
    items.push({
      type: 'PermSet', name: display,
      searchText: searchTextWithTypeKeywords('PermSet', `${label} ${name}`),
      url: `${o}/lightning/setup/PermSets/page?address=%2F${encodeURIComponent(id)}`,
    });
  }
  for (const g of permSetGroups) {
    const dev = firstDefined(g, ['DeveloperName', 'developerName']);
    const label = firstDefined(g, ['MasterLabel', 'masterLabel']) || dev || 'Permission Set Group';
    const id = firstDefined(g, ['Id', 'id']);
    if (!id) continue;
    const display = dev && label !== dev ? `${label} (${dev})` : label;
    items.push({
      type: 'PermSetGroup', name: display,
      searchText: searchTextWithTypeKeywords('PermSetGroup', `${label} ${dev}`),
      url: `${o}/lightning/setup/PermSetGroups/page?address=%2F${encodeURIComponent(id)}`,
    });
  }
  for (const t of triggers) {
    const n = firstDefined(t, ['Name', 'name']);
    const id = firstDefined(t, ['Id', 'id']);
    const table = firstDefined(t, ['TableEnumOrId', 'tableEnumOrId']);
    if (!n || !id) continue;
    items.push({
      type: 'Trigger', name: n,
      searchText: searchTextWithTypeKeywords('Trigger', `${n} ${table}`),
      url: `${o}/lightning/setup/ApexTriggers/page?address=%2F${encodeURIComponent(id)}`,
    });
  }
  for (const pg of vfPages) {
    const n = firstDefined(pg, ['Name', 'name']);
    const id = firstDefined(pg, ['Id', 'id']);
    if (!n || !id) continue;
    items.push({
      type: 'VFPage', name: n,
      searchText: searchTextWithTypeKeywords('VFPage', n),
      url: `${o}/lightning/setup/ApexPages/page?address=%2F${encodeURIComponent(id)}`,
    });
  }
  return items;
}

async function loadFromNetwork(tabUrl, tabStoreId) {
  const session = await getMyDomainSession(tabUrl, tabStoreId);
  if (!session) {
    // Distinguish "not logged in" from "Firefox host permission missing" —
    // without the grant, the cookies API silently hides the sid cookie.
    const myDomainOrigin = resolveMyDomainOrigin(tabUrl);
    let permHint = '';
    try {
      if (myDomainOrigin) {
        const granted = await chrome.permissions.contains({ origins: [`${myDomainOrigin}/*`] });
        if (!granted) {
          permHint =
            ` Firefox has not granted access to ${myDomainOrigin}. ` +
            'Click the Spotlight toolbar icon → "Grant access to Salesforce", then Refresh.';
        }
      }
    } catch (e) {
      dbgWarn('permissions.contains failed', e);
    }
    throw new Error(`No My Domain sid cookie. Make sure you are logged in.${permHint}`);
  }
  const { sid, apiBase, uiOrigin } = session;
  dbg('loadFromNetwork', { apiBase, sid: sidHint(sid) });

  const apiVersion = await findApiVersion(apiBase, sid);
  if (!apiVersion) {
    throw new Error(
      `Bearer sid from My Domain (${apiBase}) was rejected. ` +
      'Try logging out and back in to Salesforce, then click Refresh.'
    );
  }

  const [
    flows,
    sobjects,
    lwcs,
    apexes,
    profiles,
    permSets,
    permSetGroups,
    triggers,
    vfPages,
    customObjects,
    apps,
  ] = await Promise.all([
    soqlQuery(apiBase, sid, apiVersion,
      'SELECT Id,Label,ApiName,ProcessType,ActiveVersionId FROM FlowDefinitionView', 'flows', false
    ).catch(e => { dbgWarn('flows', e); return []; }),
    fetchSobjects(apiBase, sid, apiVersion).catch(e => { dbgWarn('sobjects', e); return []; }),
    soqlQuery(apiBase, sid, apiVersion,
      'SELECT Id,DeveloperName,MasterLabel FROM LightningComponentBundle', 'lwc', true
    ).catch(e => { dbgWarn('lwc', e); return []; }),
    soqlQuery(apiBase, sid, apiVersion,
      "SELECT Id,Name,NamespacePrefix FROM ApexClass WHERE NamespacePrefix = null", 'apex', true
    ).catch(e => { dbgWarn('apex', e); return []; }),
    soqlQuery(apiBase, sid, apiVersion,
      'SELECT Id,Name FROM Profile', 'profiles', false
    ).catch(e => { dbgWarn('profiles', e); return []; }),
    soqlQuery(apiBase, sid, apiVersion,
      // PermissionSetGroupId = null drops the auto-created "group" permission
      // sets that back each Permission Set Group — they exist for assignment
      // only and have no openable setup page (opening one dead-ends).
      'SELECT Id,Name,Label FROM PermissionSet WHERE IsOwnedByProfile = false AND PermissionSetGroupId = null', 'permSets', false
    ).catch(e => { dbgWarn('permSets', e); return []; }),
    soqlQuery(apiBase, sid, apiVersion,
      'SELECT Id,MasterLabel,DeveloperName FROM PermissionSetGroup', 'permSetGroups', false
    ).catch(e => { dbgWarn('permSetGroups', e); return []; }),
    soqlQuery(apiBase, sid, apiVersion,
      'SELECT Id,Name,TableEnumOrId FROM ApexTrigger WHERE NamespacePrefix = null', 'triggers', true
    ).catch(e => { dbgWarn('triggers', e); return []; }),
    soqlQuery(apiBase, sid, apiVersion,
      'SELECT Id,Name FROM ApexPage WHERE NamespacePrefix = null', 'vfPages', true
    ).catch(e => { dbgWarn('vfPages', e); return []; }),
    soqlQuery(apiBase, sid, apiVersion,
      'SELECT Id,DeveloperName,NamespacePrefix FROM CustomObject', 'customObjects', true
    ).catch(e => { dbgWarn('customObjects', e); return []; }),
    soqlQuery(apiBase, sid, apiVersion,
      "SELECT DurableId,Label,DeveloperName FROM AppDefinition WHERE UiType = 'Lightning'", 'apps', false
    ).catch(e => { dbgWarn('apps', e); return []; }),
  ]);

  const components = buildComponentList(
    uiOrigin,
    apiBase,
    flows,
    sobjects,
    lwcs,
    apexes,
    profiles,
    permSets,
    permSetGroups,
    triggers,
    vfPages,
    customObjects,
    apps
  );
  const counts = {
    flows: flows.length,
    objects: sobjects.length,
    lwc: lwcs.length,
    apex: apexes.length,
    profiles: profiles.length,
    permSets: permSets.length,
    permSetGroups: permSetGroups.length,
    triggers: triggers.length,
    vfPages: vfPages.length,
    setup: SETUP_PAGES.length,
    objectSetup: components.filter((c) => c.type === 'ObjectSetup').length,
    cmdt: components.filter((c) => c.type === 'CMDT').length,
    customSettings: components.filter((c) => c.type === 'CustomSetting').length,
    apps: apps.length,
  };
  dbg('built', components.length, 'components', counts);
  return { components, counts, uiOrigin, apiBase, apiVersion };
}

// Keyboard shortcut (default Ctrl+Shift+Space, user-changeable in
// about:addons → gear → Manage Extension Shortcuts) → tell the active tab.
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-spotlight') return;
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs && tabs[0];
    if (!tab || tab.id == null) return;
    chrome.tabs.sendMessage(tab.id, { action: 'toggleSpotlight' }, () => {
      if (chrome.runtime.lastError) {
        // Not a Salesforce tab (no content script) — ignore.
        dbg('toggle-spotlight: no receiver', chrome.runtime.lastError.message);
      }
    });
  } catch (e) {
    dbgWarn('toggle-spotlight error', e);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.action !== 'fetchComponents') return false;

  const tabUrl = message.tabUrl || '';
  const forceRefresh = Boolean(message.forceRefresh);
  // Firefox: the sending tab's cookie store (container/private window aware).
  const tabStoreId = (sender && sender.tab && sender.tab.cookieStoreId) || '';
  const host = orgCacheHost(tabUrl);
  if (!host) { sendResponse({ ok: false, error: 'Bad URL' }); return false; }

  dbg('fetchComponents', { host, forceRefresh, tabStoreId });

  // Lightning UI origin for the current org — content builds user-defined setup
  // page URLs against this so a stored path resolves on whatever org you browse.
  const uiOrigin = resolveUiOrigin(tabUrl);

  (async () => {
    try {
      const key = cacheKey(host);
      if (!forceRefresh) {
        const stored = await chrome.storage.local.get(key);
        const entry = stored[key];
        if (entry && Array.isArray(entry.components) && entry.components.length > 0 && entry.updatedAt) {
          const age = Date.now() - entry.updatedAt;
          if (age < CACHE_TTL_MS) {
            dbg('cache HIT', key, entry.components.length, 'items, age', age);
            // Content applies the choices (drops not-picked choice-group siblings)
            // so selection takes effect live without racing the cache write.
            sendResponse({ ok: true, components: entry.components, cached: true, counts: entry.counts, choices: entry.choices || {}, uiOrigin });
            return;
          }
        }
      }
      const fresh = await loadFromNetwork(tabUrl, tabStoreId);
      await chrome.storage.local.set({
        [key]: { updatedAt: Date.now(), components: fresh.components, counts: fresh.counts },
      });
      dbg('stored', fresh.components.length, 'components');
      // A fresh build resets choices — both variants show until the user picks again.
      sendResponse({ ok: true, components: fresh.components, cached: false, counts: fresh.counts, choices: {}, uiOrigin: fresh.uiOrigin || uiOrigin });
    } catch (err) {
      dbgWarn('error', err);
      sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
    }
  })();
  return true;
});

// Persist a per-org choice (e.g. which "Users" variant the user opened). Stored
// inside the org's cache entry so it lives exactly as long as the cache does —
// a refresh/flush rebuilds the entry and the choice resets, showing both again.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.action !== 'setChoice') return false;
  const tabUrl = message.tabUrl || '';
  const group = message.choiceGroup;
  const variant = message.choiceVariant;
  const host = orgCacheHost(tabUrl);
  if (!host) { sendResponse({ ok: false }); return false; }
  if (!group || !variant) { sendResponse({ ok: false }); return false; }

  (async () => {
    try {
      const key = cacheKey(host);
      const stored = await chrome.storage.local.get(key);
      const entry = stored[key];
      // No cache entry means nothing to stick the choice to; it will simply be
      // recorded on the next open after the cache is built.
      if (!entry || !Array.isArray(entry.components)) { sendResponse({ ok: false }); return; }
      const choices = { ...(entry.choices || {}), [group]: variant };
      // Preserve updatedAt so recording a choice never extends the cache TTL.
      await chrome.storage.local.set({ [key]: { ...entry, choices } });
      dbg('setChoice', group, '=', variant, 'for', host);
      sendResponse({ ok: true });
    } catch (err) {
      dbgWarn('setChoice error', err);
      sendResponse({ ok: false });
    }
  })();
  return true;
});
