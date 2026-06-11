# Slim Installer: Remove Module/Asset Management

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Strip the installer down to "install Schwung, then use schwung.local" — remove module catalog, asset browser, custom module, and post-install module management code. Keep WiFi manager (needed when schwung.local isn't reachable yet).

**Architecture:** The installer becomes a focused tool: discover device → authenticate → SSH setup → install core → show success pointing to schwung.local. When Schwung is already installed, show a simple status screen with re-enable, repair (core only), uninstall, WiFi config, screen reader toggle, and a prominent link to schwung.local — no module listing, no asset browser.

**Tech Stack:** Electron, vanilla JS, SSH2/SFTP

---

## Design Decision: Fresh Install Scope

The fresh install currently offers Complete/Custom/Core install types. In the new model:
- **Install core only** — no module selection, no module catalog fetch
- The Module Store (built into Schwung) handles module installation via schwung.local
- This eliminates `getModuleCatalog`, `downloadRelease` (for modules), `installModulePackage`, `installModuleBatch`, and all module selection UI

The install flow becomes: download core tarball → install via SSH → done.

## What We Keep

- Device discovery and validation (`validateDevice`, DNS resolution)
- Authentication flow (challenge/code/cookie)
- SSH key setup (find/generate/submit/test/fallback/config)
- Core installation (`getLatestRelease`, `downloadRelease` for core, `installMain`)
- Installer update check (`checkInstallerUpdate`)
- Re-enable (`checkShimActive`, `reenableMoveEverything`)
- Repair (reinstall core only — no module reinstall)
- Uninstall (`uninstallMoveEverything`)
- Screen reader toggle (`getScreenReaderStatus`, `setScreenReaderState`)
- Check core installation (`checkCoreInstallation`)
- Diagnostics (`getDiagnostics`)
- WiFi manager (`wifiGetStatus`, `wifiScan`, `wifiListServices`, `wifiConnect`, `wifiDisconnect`, `wifiRemoveService`, `wifiEnableRadio`)
- Utilities (`cleanDeviceTmp`, `fixPermissions`, `clearDnsCache`, `testSshFormats`)
- Export logs

## What We Remove

### backend.js functions
- `getModuleCatalog` (~line 1076)
- `installModulePackage` (~line 1788)
- `installModuleBatch` (~line 1823)
- `removeModulePackage` (~line 2547)
- `installCustomModule` (~line 3148)
- `uploadModuleAssets` (~line 2489)
- `listRemoteDir` (~line 1982)
- `deleteRemotePath` (~line 2013)
- `createRemoteDir` (~line 2028)
- `downloadRemoteFile` (~line 1500)
- `checkInstalledVersions` (~line 2282)
- `compareVersions` (~line 2379)
- `checkGitBashAvailable` (~line 1541)
- `getStandaloneStatus` / `setStandaloneState`

### main.js IPC handlers
- `get_module_catalog`
- `install_module_package`, `install_module_batch`, `remove_module`, `install_custom_module`
- `pick_tarball`, `pick_asset_files`
- `upload_assets`, `list_remote_dir`, `delete_remote_path`, `create_remote_dir`, `download_remote_file`
- `check_installed_versions`, `compare_versions`
- `check_git_bash_available`
- `get_standalone_status`, `set_standalone_state`

Keep all `wifi_*` handlers (still needed).

### preload.js
- Remove `batch-install-progress` and `version-check-progress` from valid channels

### index.html
- Remove Asset Browser Modal (lines 226-246)
- Remove Custom Module Modal (lines 247-272)
- Keep WiFi Manager Modal (lines 273-311)
- Remove management mode sections from modules screen: `management-top-actions`, `core-upgrade-row`, `installed-modules`, `available-modules`
- Remove secondary action links: Browse Files (keep WiFi, Repair, Screen Reader, Uninstall)
- Remove module selection radio group (Complete/Custom/Core) and module-categories div
- Simplify to a single "Install Schwung" confirmation

### app.js functions
- `checkVersions` — replace with simpler `checkIfInstalled`
- `loadModuleList`, `setupInstallationOptions`, `displayModules`, `updateSelectedModules`
- `displayManagementModules` and all management-mode UI logic
- `openCustomModuleModal`, `closeCustomModuleModal`, `handleCustomModuleBrowse`, `handleCustomModuleInstall`
- `openAssetBrowser`, `closeAssetBrowser`, `openGlobalFileBrowser`, `refreshAssetListing`, `navigateToSubdir`
- `handleDownloadAssetEntry`, `handleDeleteAssetEntry`, `handleAssetBrowserUpload`, `handleAssetBrowserMkdir`
- `handleUpgradeCore`, `handleUpgradeAll`, `handleInstallAll`
- `handleUpgradeModule`, `handleRemoveModule`, `handleInstallModule`
- `getInstallSubdir`, `enqueueModuleOp`, `processModuleOpQueue`
- All asset/custom-module related event listeners and drag-drop handlers
- Module install loop in `startInstallation` (keep core install only)
- Module reinstall loop in repair handler (keep core reinstall only)

### style.css
- Remove `.modal-overlay`, `.modal-content`, `.modal-header`, `.modal-close-btn` styles (~lines 1002-1055)
- Remove `.asset-*` styles (~lines 1057-1250)
- Remove `.custom-module-*` styles
- Remove `.wifi-*` styles
- Remove management-mode styles (`.btn-action`, module row styles, etc.)

---

### Task 1: Create a feature branch

**Step 1: Create and switch to feature branch**

Run: `git checkout -b slim-installer`

**Step 2: Commit**

No commit needed — just branch creation.

---

### Task 2: Gut index.html — remove modals and simplify modules screen

**Files:**
- Modify: `ui/index.html`

**Step 1: Remove two modals (keep WiFi)**

Delete the Asset Browser Modal (lines 226-246) and Custom Module Modal (lines 247-272). Keep the WiFi Manager Modal (lines 273-311).

**Step 2: Simplify the modules screen**

Replace the current `screen-modules` content. Remove:
- The install type radio group (Complete/Custom/Core)
- `management-top-actions`, `core-upgrade-row`, `installed-modules`, `available-modules`, `module-categories`
- The secondary actions: keep only Repair, Screen Reader, Uninstall (remove Browse Files, WiFi)

The new modules screen for fresh install should just show:
- "Install Schwung" heading
- Accessibility checkbox (screen reader)
- Install button + Back button

For already-installed state, show:
- "Schwung is Installed" heading
- Link to schwung.local
- Re-enable banner (kept as-is)
- Secondary links: WiFi, Repair, Screen Reader, Uninstall

**Step 3: Verify the HTML is valid**

Open in browser or check structure manually.

**Step 4: Commit**

```bash
git add ui/index.html
git commit -m "strip modals and management UI from index.html"
```

---

### Task 3: Slim down backend.js — remove module/asset functions

**Files:**
- Modify: `electron/backend.js`

**Step 1: Remove module management functions**

Delete: `getModuleCatalog`, `installModulePackage`, `installModuleBatch`, `removeModulePackage`, `installCustomModule`, `checkInstalledVersions`, `compareVersions`, `checkGitBashAvailable`.

**Step 2: Remove asset/file browser functions**

Delete: `uploadModuleAssets`, `listRemoteDir`, `deleteRemotePath`, `createRemoteDir`, `downloadRemoteFile`.

**Step 3: Remove standalone status functions**

Delete: `getStandaloneStatus`, `setStandaloneState`.

**Step 4: Clean up module.exports**

Remove all deleted function names from the `module.exports` object at the bottom of the file.

**Step 5: Verify no broken references**

Run: `grep -n` for each removed function name across the codebase to ensure no dangling references.

**Step 6: Commit**

```bash
git add electron/backend.js
git commit -m "remove module catalog, asset browser, and version management from backend"
```

---

### Task 4: Slim down main.js — remove IPC handlers

**Files:**
- Modify: `electron/main.js`
- Modify: `electron/preload.js`

**Step 1: Remove IPC handlers for deleted backend functions**

Delete these `ipcMain.handle` blocks:
- `get_module_catalog`
- `install_module_package`, `install_module_batch`, `remove_module`, `install_custom_module`
- `pick_tarball`, `pick_asset_files`
- `upload_assets`, `list_remote_dir`, `delete_remote_path`, `create_remote_dir`, `download_remote_file`
- `check_installed_versions`, `compare_versions`
- `check_git_bash_available`
- `get_standalone_status`, `set_standalone_state`
- All `wifi_*` handlers (7 handlers, lines 293-319)

**Step 2: Update preload.js**

Remove `'version-check-progress'` and `'batch-install-progress'` from the `validChannels` array since those events no longer exist.

**Step 3: Commit**

```bash
git add electron/main.js electron/preload.js
git commit -m "remove IPC handlers for deleted module/asset/WiFi features"
```

---

### Task 5: Rewrite app.js — simplify to install-only flow

This is the biggest task. The current app.js is 3,344 lines. Target: ~800-1000 lines.

**Files:**
- Modify: `ui/app.js`

**Step 1: Remove asset browser code**

Delete: `openAssetBrowser`, `closeAssetBrowser`, `openGlobalFileBrowser`, `refreshAssetListing`, `navigateToSubdir`, `handleDownloadAssetEntry`, `handleDeleteAssetEntry`, `handleAssetBrowserUpload`, `handleAssetBrowserMkdir`, `uploadFilesToCurrentDir`, `showAssetSpinner`, `setAssetStatus`, the `assetBrowser` state object, and all asset browser event listeners + drag-drop handlers.

**Step 2: Remove custom module code**

Delete: `openCustomModuleModal`, `closeCustomModuleModal`, `handleCustomModuleBrowse`, `handleCustomModuleInstall`, and related event listeners.

**Step 3: Remove module management functions**

Delete: `loadModuleList`, `setupInstallationOptions`, `displayModules`, `updateSelectedModules`, `displayManagementModules`, `getInstallSubdir`, `enqueueModuleOp`, `processModuleOpQueue`, `handleUpgradeCore`, `handleUpgradeAll`, `handleInstallAll`, `handleUpgradeModule`, `handleRemoveModule`, `handleInstallModule`.

**Step 4: Replace `checkVersions` with simple `checkIfInstalled`**

New function:
```javascript
async function checkIfInstalled() {
    try {
        const hostname = state.deviceIp;
        const coreCheck = await window.installer.invoke('check_core_installation', { hostname });

        if (!coreCheck.installed) {
            // Fresh install mode
            state.managementMode = false;
            document.querySelector('#screen-modules h1').textContent = 'Install Schwung';
            document.getElementById('btn-install').textContent = 'Install';
            document.querySelector('.install-options').style.display = 'block';
            document.getElementById('secondary-actions').style.display = 'none';
            document.getElementById('reenable-banner').style.display = 'none';

            // Show version
            try {
                const release = await window.installer.invoke('get_latest_release');
                if (release && release.version) {
                    document.getElementById('core-version-subtitle').textContent = `Version ${release.version}`;
                    document.getElementById('core-version-subtitle').style.display = '';
                }
            } catch (e) {
                document.getElementById('core-version-subtitle').style.display = 'none';
            }

            showScreen('modules');
            return;
        }

        // Already installed
        state.managementMode = true;
        await window.installer.invoke('setup_ssh_config', { hostname: state.hostname });

        // Check shim status
        try {
            const shimStatus = await window.installer.invoke('check_shim_active', { hostname });
            state.shimDisabled = !shimStatus.active;
        } catch (e) {
            state.shimDisabled = false;
        }

        document.querySelector('#screen-modules h1').textContent = 'Schwung is Installed';
        document.querySelector('.install-options').style.display = 'none';
        document.getElementById('secondary-actions').style.display = 'flex';
        document.getElementById('reenable-banner').style.display = state.shimDisabled ? 'flex' : 'none';
        document.querySelector('#screen-modules > .action-buttons').style.display = 'none';

        // Show version
        if (coreCheck.core) {
            document.getElementById('core-version-subtitle').textContent = `Version ${coreCheck.core}`;
            document.getElementById('core-version-subtitle').style.display = '';
        }

        showScreen('modules');
    } catch (error) {
        console.error('Install check failed:', error);
        state.managementMode = false;
        showScreen('modules');
    }
}
```

**Step 5: Simplify `startInstallation`**

Remove the module install loop. Keep only: SSH config → download core → install core → success.

```javascript
async function startInstallation() {
    showScreen('installing');
    try {
        initializeChecklist([]);  // core only

        updateInstallProgress('Setting up SSH configuration...', 0);
        await window.installer.invoke('setup_ssh_config', { hostname: state.hostname });

        updateInstallProgress('Fetching latest release...', 10);
        const release = await window.installer.invoke('get_latest_release');

        updateInstallProgress(`Downloading ${release.asset_name}...`, 20);
        const tarballPath = await window.installer.invoke('download_release', {
            url: release.download_url,
            destPath: `/tmp/${release.asset_name}`
        });

        const installFlags = [];
        if (state.enableScreenReader) installFlags.push('--enable-screen-reader');

        updateChecklistItem('core', 'in-progress');
        updateInstallProgress('Installing Schwung...', 40);
        await window.installer.invoke('install_main', {
            tarballPath,
            hostname: state.deviceIp,
            flags: installFlags
        });
        updateChecklistItem('core', 'completed');

        updateInstallProgress('Installation complete!', 100);
        setTimeout(() => {
            populateSuccessScreen();
            showScreen('success');
        }, 500);
    } catch (error) {
        state.errors.push({ timestamp: new Date().toISOString(), message: error.toString() });
        showError('Installation failed: ' + error);
    }
}
```

**Step 6: Simplify repair handler**

Remove the module reinstall loop from the repair handler. Repair = reinstall core only.

**Step 7: Remove state fields no longer needed**

Remove from `state`: `installType`, `selectedModules`, `versionInfo`, `installedModules`. Remove `allModules`.

**Step 8: Clean up event listeners in DOMContentLoaded**

Remove listeners for: `btn-upgrade-all`, `link-browse-files`, asset browser events, custom module events, drag-drop handlers. Keep WiFi event listeners. Update `btn-back-manage` handler to go back to `checkIfInstalled`.

**Step 9: Update `populateSuccessScreen`**

Remove the `isUpgrade` path (no more upgrades from installer). Keep: fresh install, uninstall, re-enable, repair. Make the schwung.local link more prominent on the fresh install success.

**Step 10: Commit**

```bash
git add ui/app.js
git commit -m "rewrite app.js: remove module management, simplify to install-only flow"
```

---

### Task 6: Clean up style.css — remove modal and management styles

**Files:**
- Modify: `ui/style.css`

**Step 1: Keep modal base styles** (needed for WiFi modal)

`.modal-overlay`, `.modal-content`, `.modal-header`, `.modal-close-btn` stay.

**Step 2: Remove asset browser styles**

Delete all `.asset-*` rules (~lines 1057-1250).

**Step 3: Remove custom module styles**

Delete all `.custom-module-*` rules.

**Step 4: Keep WiFi styles** (WiFi modal stays)

**Step 5: Remove management-mode module row styles**

Delete styles for `.module-row`, `.btn-action`, `.btn-install-module`, `.btn-remove-module`, etc. that were only used in management mode. Be careful to keep `.btn-action` only if still used elsewhere.

**Step 6: Commit**

```bash
git add ui/style.css
git commit -m "remove asset browser, custom module, and management styles from CSS"
```

---

### Task 7: Add schwung.local prominence to installed state

**Files:**
- Modify: `ui/index.html`
- Modify: `ui/style.css`
- Modify: `ui/app.js`

**Step 1: Add schwung.local info box to the modules screen**

When Schwung is already installed, the modules screen should prominently show:

```html
<div id="installed-info" class="info-box" style="display: none;">
    <p><strong>Manage your installation at:</strong></p>
    <p style="font-size: 1.2rem;"><a href="http://schwung.local" target="_blank">schwung.local</a></p>
    <p style="color: #b8b8b8;">Install modules, manage assets, and more.</p>
</div>
```

**Step 2: Show/hide in `checkIfInstalled`**

In the already-installed branch of `checkIfInstalled`, show `installed-info`. In the fresh-install branch, hide it.

**Step 3: Commit**

```bash
git add ui/index.html ui/app.js ui/style.css
git commit -m "add prominent schwung.local link for already-installed state"
```

---

### Task 8: Verify and test

**Step 1: Run the app**

Run: `cd /Volumes/ExtFS/charlesvestal/github/schwung-parent/schwung-installer && npm start`

Verify:
- Warning screen shows correctly
- Discovery flow works
- If device found with Schwung installed: shows "Schwung is Installed" with schwung.local link + secondary actions (WiFi, Repair, Screen Reader, Uninstall)
- If device found without Schwung: shows "Install Schwung" with accessibility checkbox + Install button
- No console errors about missing elements or event listeners

**Step 2: Check for dead code**

Run: `grep -rn 'module_catalog\|installModulePackage\|assetBrowser\|customModule' ui/ electron/` — should return nothing.

**Step 3: Check file sizes**

Compare before/after line counts. Target reductions:
- backend.js: ~3,291 → ~1,500
- app.js: ~3,344 → ~800-1,000
- main.js: ~332 → ~180
- style.css: ~1,584 → ~1,000
- index.html: ~333 → ~200

**Step 4: Commit any fixes**

```bash
git add -A
git commit -m "fix any issues found during testing"
```

---

### Task 9: Version bump

**Step 1: Bump version in package.json**

Update version from `0.3.4` to `0.4.0` (minor bump — this is a significant feature change).

**Step 2: Commit**

```bash
git add package.json
git commit -m "chore: bump version to 0.4.0 for slim installer"
```
