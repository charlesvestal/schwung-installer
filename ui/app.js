// Test: Change text to confirm app.js is loading
document.getElementById('status-text').textContent = 'app.js is loading...';

// Pre-warm local network permission on macOS.
// The first request to a .local address triggers the system "Local Network" dialog.
// Fire it now so the dialog appears while the user reads the warning screen,
// rather than blocking discovery later.
(async () => {
    try {
        console.log('[DEBUG] Pre-warming local network access...');
        await window.installer.invoke('validate_device_at', { baseUrl: 'http://move.local' });
        console.log('[DEBUG] Local network pre-warm succeeded');
    } catch (e) {
        console.log('[DEBUG] Local network pre-warm failed (expected):', e.message);
    }
})();

// Log buffer for export
const logBuffer = [];
function addLog(source, message) {
    const timestamp = new Date().toISOString();
    logBuffer.push(`[${timestamp}] [${source}] ${message}`);
}

async function exportLogs() {
    const header = `Schwung Installer Logs\nExported: ${new Date().toISOString()}\nPlatform: ${navigator.platform}\nUser Agent: ${navigator.userAgent}\n${'='.repeat(60)}\n\n`;
    const logs = header + logBuffer.join('\n');
    try {
        const saved = await window.installer.invoke('export_logs', { logs });
        if (saved) {
            alert('Logs saved successfully.');
        }
    } catch (err) {
        // Fallback: copy to clipboard
        try {
            await navigator.clipboard.writeText(logs);
            alert('Logs copied to clipboard.');
        } catch (e) {
            console.error('Failed to export logs:', e);
        }
    }
}

// Application State
const state = {
    currentScreen: 'discovery',
    hostname: 'move.local',
    deviceIp: null,
    authCode: null,
    baseUrl: null,
    enableScreenReader: false,
    sshPassword: null,
    errors: [],
    shimDisabled: false,
    managementMode: false
};

// Screen Management
function showScreen(screenName) {
    document.querySelectorAll('.screen').forEach(screen => {
        screen.classList.remove('active');
    });
    document.getElementById(`screen-${screenName}`).classList.add('active');
    state.currentScreen = screenName;

    // Stop SSH confirmation polling when leaving the confirm screen
    if (screenName !== 'confirm' && confirmationPollInterval) {
        clearInterval(confirmationPollInterval);
        confirmationPollInterval = null;
    }

    // Reset installing screen state so stale progress/checklist never leaks
    if (screenName === 'installing') {
        document.getElementById('install-checklist').innerHTML = '';
        document.getElementById('install-status').textContent = 'Preparing...';
        const progressFill = document.querySelector('.progress-fill');
        if (progressFill) progressFill.style.width = '0%';
    }
}

// Device Discovery - Try configured hostname first, fall back to manual entry
async function startDeviceDiscovery() {
    // Reset discovery UI state
    document.querySelector('.manual-entry').style.display = 'none';

    // Read hostname from input field
    const hostnameInput = document.getElementById('device-hostname');
    if (hostnameInput && hostnameInput.value.trim()) {
        state.hostname = hostnameInput.value.trim();
    }

    console.log('[DEBUG] Trying', state.hostname, 'first...');

    const statusDiv = document.getElementById('discovery-status');
    statusDiv.innerHTML = `<div class="spinner"></div><p>Connecting to ${state.hostname}...</p>`;

    // Clear any cached DNS state from a previous failed attempt
    try {
        await window.installer.invoke('clear_dns_cache');
    } catch (e) {
        // Non-critical, continue with discovery
    }

    // Try configured hostname directly
    try {
        const baseUrl = `http://${state.hostname}`;
        const result = await window.installer.invoke('validate_device_at', { baseUrl });
        const isValid = result === true || (result && result.valid !== false);

        if (isValid) {
            console.log('[DEBUG]', state.hostname, 'validated successfully');
            statusDiv.innerHTML = `<p style="color: green;">&#10003; Connected to ${state.hostname}</p>`;

            // Automatically proceed to next step
            setTimeout(() => {
                selectDevice(state.hostname);
            }, 500);
            return;
        }

        // Extract error detail if available
        const errorDetail = (result && result.error) ? result.error : '';
        if (errorDetail) {
            console.error('[DEBUG]', state.hostname, 'validation failed:', errorDetail);
        }
    } catch (error) {
        console.error('[DEBUG]', state.hostname, 'validation failed:', error);
    }

    // HTTP failed — try SSH as fallback (device may have broken web server)
    console.log('[DEBUG] HTTP failed, trying SSH fallback...');
    statusDiv.innerHTML = `<div class="spinner"></div><p>Web interface unreachable. Checking SSH connection...</p>`;

    try {
        const sshResult = await window.installer.invoke('try_ssh_fallback', { hostname: state.hostname });
        if (sshResult && sshResult.sshAvailable) {
            console.log('[DEBUG] SSH fallback succeeded, IP:', sshResult.ip);
            statusDiv.innerHTML =
                `<p style="color: orange;">&#9888; Web interface on ${state.hostname} is not responding, but SSH is available.</p>` +
                `<p>This usually means Schwung needs to be repaired. The installer can fix this over SSH.</p>` +
                `<button id="btn-ssh-repair" style="margin: 0.5rem 0;">Repair via SSH</button>` +
                `<button id="btn-retry-discovery" style="margin: 0.5rem 0.5rem;">Retry</button>`;
            document.getElementById('btn-ssh-repair').onclick = () => {
                state.deviceIp = state.hostname;
                startSshRepair();
            };
            document.getElementById('btn-retry-discovery').onclick = () => startDeviceDiscovery();
            document.querySelector('.manual-entry').style.display = 'block';
            return;
        }
    } catch (sshErr) {
        console.log('[DEBUG] SSH fallback error:', sshErr);
    }

    // Both HTTP and SSH failed — show standard error
    const isMac = navigator.platform.startsWith('Mac') || navigator.userAgent.includes('Macintosh');
    const lnpHint = isMac
        ? `<p style="font-size: 0.85em; color: #888;">On macOS, check System Settings &gt; Privacy &amp; Security &gt; Local Network and make sure Schwung Installer is allowed.</p>`
        : '';
    statusDiv.innerHTML = `<p style="color: orange;">Could not connect to ${state.hostname}</p>` +
        `<p>Make sure your Move is powered on and connected to the same WiFi network, then try again.</p>` +
        lnpHint +
        `<button id="btn-retry-discovery" style="margin: 0.5rem 0;">Retry</button>` +
        `<p style="margin-top: 0.5rem;">Or enter your Move\'s IP address below:</p>`;
    document.getElementById('btn-retry-discovery').onclick = () => startDeviceDiscovery();
    document.querySelector('.manual-entry').style.display = 'block';
}

function displayDevices(devices) {
    const deviceList = document.getElementById('device-list');
    const discoveryStatus = document.getElementById('discovery-status');

    if (devices.length === 0) {
        discoveryStatus.innerHTML = '<p>No devices found. Try entering IP manually below.</p>';
        return;
    }

    discoveryStatus.style.display = 'none';
    deviceList.innerHTML = '';

    devices.forEach(device => {
        const item = document.createElement('div');
        item.className = 'device-item';
        item.innerHTML = `
            <h3>${device.name || 'Ableton Move'}</h3>
            <p>${device.ip}</p>
        `;
        item.onclick = () => selectDevice(device.ip);
        deviceList.appendChild(item);
    });
}

async function selectDevice(hostname) {
    state.deviceIp = hostname;
    state.hostname = hostname;

    const statusDiv = document.getElementById('discovery-status');
    statusDiv.innerHTML = '<div class="spinner"></div><p>Validating device...</p>';

    try {
        // Validate device is reachable
        const baseUrl = `http://${hostname}`;
        const result = await window.installer.invoke('validate_device_at', { baseUrl });
        const isValid = result === true || (result && result.valid !== false);

        if (isValid) {
            console.log('[DEBUG] Device validated, checking for saved cookie...');
            // Check if we have a saved cookie
            const savedCookie = await window.installer.invoke('get_saved_cookie');

            // First, test if SSH already works
            console.log('[DEBUG] Testing SSH connection...');
            const sshWorks = await window.installer.invoke('test_ssh', { hostname: hostname });

            if (sshWorks) {
                console.log('[DEBUG] SSH already works, proceeding to install check');
                await checkIfInstalled();
                return;
            }

            console.log('[DEBUG] SSH not available yet, need to set up key');

            if (savedCookie) {
                console.log('[DEBUG] Found saved cookie, proceeding to SSH setup');
                // Try to use saved cookie, skip to SSH setup
                proceedToSshSetup(baseUrl);
            } else {
                console.log('[DEBUG] No saved cookie, requesting challenge code');
                // Request challenge code from Move
                await window.installer.invoke('request_challenge', { baseUrl });
                // Show code entry screen
                showScreen('code-entry');
                setupCodeEntry();
            }
        } else {
            // HTTP validation failed — try SSH fallback
            console.log('[DEBUG] selectDevice: HTTP failed, trying SSH fallback...');
            statusDiv.innerHTML = '<div class="spinner"></div><p>Web interface unreachable. Checking SSH connection...</p>';

            try {
                const sshResult = await window.installer.invoke('try_ssh_fallback', { hostname });
                if (sshResult && sshResult.sshAvailable) {
                    console.log('[DEBUG] selectDevice: SSH fallback succeeded');
                    const errorDetail = (result && result.error) ? ` (${result.error})` : '';
                    statusDiv.innerHTML =
                        `<p style="color: orange;">&#9888; Web interface not responding${errorDetail}, but SSH is available.</p>` +
                        `<p>This usually means Schwung needs to be repaired. The installer can fix this over SSH.</p>` +
                        `<button id="btn-ssh-repair" style="margin: 0.5rem 0;">Repair via SSH</button>` +
                        `<button id="btn-retry-discovery" style="margin: 0.5rem 0.5rem;">Retry</button>`;
                    document.getElementById('btn-ssh-repair').onclick = () => {
                        startSshRepair();
                    };
                    document.getElementById('btn-retry-discovery').onclick = () => startDeviceDiscovery();
                    document.querySelector('.manual-entry').style.display = 'block';
                    return;
                }
            } catch (sshErr) {
                console.log('[DEBUG] selectDevice: SSH fallback error:', sshErr);
            }

            // Both HTTP and SSH failed
            const errorDetail = (result && result.error) ? `: ${result.error}` : '';
            const isMac = navigator.platform.startsWith('Mac') || navigator.userAgent.includes('Macintosh');
            const lnpHint = isMac
                ? `<p style="font-size: 0.85em; color: #888;">On macOS, check System Settings &gt; Privacy &amp; Security &gt; Local Network and make sure Schwung Installer is allowed.</p>`
                : '';
            statusDiv.innerHTML = `<p style="color: red;">Could not reach Move device${errorDetail}</p>` +
                `<p style="font-size: 0.85em; color: #888;">Check that your Move is on the same network and try again.</p>` +
                lnpHint;
            document.querySelector('.manual-entry').style.display = 'block';
        }
    } catch (error) {
        console.error('[DEBUG] selectDevice error:', error);
        statusDiv.innerHTML = '<p style="color: red;">Error: ' + error + '</p>';
        document.querySelector('.manual-entry').style.display = 'block';
    }
}

// Code Entry
function setupCodeEntry() {
    const codeDigits = document.querySelectorAll('.code-digit');
    const submitButton = document.getElementById('btn-submit-code');

    // Auto-focus first digit
    codeDigits[0].focus();

    // Handle digit input
    codeDigits.forEach((digit, index) => {
        digit.value = '';

        digit.addEventListener('input', (e) => {
            const value = e.target.value;

            if (value.length === 1 && /^\d$/.test(value)) {
                if (index < codeDigits.length - 1) {
                    codeDigits[index + 1].focus();
                }
            }

            // Check if all digits are filled
            const allFilled = Array.from(codeDigits).every(d => d.value.length === 1);
            submitButton.disabled = !allFilled;
        });

        digit.addEventListener('keydown', (e) => {
            if (e.key === 'Backspace' && !e.target.value && index > 0) {
                codeDigits[index - 1].focus();
            }
        });

        // Allow paste
        digit.addEventListener('paste', (e) => {
            e.preventDefault();
            const pastedData = e.clipboardData.getData('text');
            const digits = pastedData.replace(/\D/g, '').slice(0, 6);

            digits.split('').forEach((char, i) => {
                if (codeDigits[i]) {
                    codeDigits[i].value = char;
                }
            });

            if (codeDigits[digits.length - 1]) {
                codeDigits[digits.length - 1].focus();
            }

            const allFilled = Array.from(codeDigits).every(d => d.value.length === 1);
            submitButton.disabled = !allFilled;
        });
    });
}

async function submitAuthCode() {
    const codeDigits = document.querySelectorAll('.code-digit');
    const code = Array.from(codeDigits).map(d => d.value).join('');
    state.authCode = code;

    try {
        const baseUrl = `http://${state.deviceIp}`;
        const cookieValue = await window.installer.invoke('submit_auth_code', {
            baseUrl: baseUrl,
            code: code
        });

        console.log('Auth successful, cookie saved');

        // On Windows, check for Git Bash before proceeding
        const gitBashCheck = await window.installer.invoke('check_git_bash_available');
        if (!gitBashCheck.available) {
            showError(
                'Git Bash is required for installation on Windows.\n\n' +
                'Please install Git for Windows from:\n' +
                'https://git-scm.com/download/win\n\n' +
                'Then restart the installer.'
            );
            return;
        }

        // Check for SSH key and show confirmation screen
        showSshKeyScreen(baseUrl);
    } catch (error) {
        showError('Failed to submit code: ' + error);
    }
}

async function showSshKeyScreen(baseUrl) {
    try {
        // Find or check if SSH key exists
        console.log('[DEBUG] Looking for existing SSH key...');
        let pubkeyPath = await window.installer.invoke('find_existing_ssh_key');

        const messageEl = document.getElementById('ssh-key-message');
        const explanationEl = document.getElementById('ssh-key-explanation');

        if (pubkeyPath) {
            console.log('[DEBUG] Found SSH key:', pubkeyPath);
            messageEl.textContent = 'Secure connection key found. Ready to add it to your Move device.';
            explanationEl.style.display = 'none';
        } else {
            console.log('[DEBUG] No SSH key found');
            messageEl.textContent = 'No secure connection key found. A new key will be generated and added to your Move device.';
            explanationEl.style.display = 'block';
        }

        // Store baseUrl for later
        state.baseUrl = baseUrl;

        showScreen('ssh-key');
    } catch (error) {
        showError('Connection setup failed: ' + error);
    }
}

async function proceedToSshSetup(baseUrl) {
    try {
        // Show confirmation screen FIRST (before submitting key)
        showScreen('confirm');

        // Find or generate SSH key
        console.log('[DEBUG] Looking for existing SSH key...');
        let pubkeyPath = await window.installer.invoke('find_existing_ssh_key');
        console.log('[DEBUG] Found SSH key:', pubkeyPath);

        if (!pubkeyPath) {
            console.log('[DEBUG] No SSH key found, generating new one');
            pubkeyPath = await window.installer.invoke('generate_new_ssh_key');
            console.log('[DEBUG] Generated SSH key:', pubkeyPath);
        }

        // Read public key content
        console.log('[DEBUG] Reading public key...');
        const pubkey = await window.installer.invoke('read_public_key', { path: pubkeyPath });
        console.log('[DEBUG] Public key length:', pubkey.length);
        console.log('[DEBUG] Public key preview:', pubkey.substring(0, 50) + '...');

        // Submit SSH key with auth cookie (this triggers prompt on Move)
        console.log('[DEBUG] Submitting SSH key to', baseUrl);
        await window.installer.invoke('submit_ssh_key_with_auth', {
            baseUrl: baseUrl,
            pubkey: pubkey
        });
        console.log('[DEBUG] SSH key submitted successfully');

        // Start polling for connection access
        startConfirmationPolling();
    } catch (error) {
        // SSH key submission failed — clear stale cookie and restart auth flow
        console.log('[DEBUG] SSH setup failed, clearing cookie and restarting auth...', error);
        await window.installer.invoke('clear_saved_cookie');
        try {
            await window.installer.invoke('request_challenge', { baseUrl });
        } catch (challengeErr) {
            console.error('[DEBUG] Challenge request also failed:', challengeErr);
        }
        showScreen('code-entry');
        setupCodeEntry();
    }
}

// SSH Confirmation Polling
let confirmationPollInterval;

async function startConfirmationPolling() {
    console.log('[DEBUG] Starting confirmation polling...');
    showScreen('confirm');

    const MAX_POLLS = 30;
    let pollCount = 0;
    const statusEl = document.querySelector('#screen-confirm .instruction:last-of-type');
    const startTime = Date.now();

    confirmationPollInterval = setInterval(async () => {
        try {
            // Stop if we've navigated away from the confirm screen
            if (state.currentScreen !== 'confirm') {
                clearInterval(confirmationPollInterval);
                confirmationPollInterval = null;
                return;
            }

            pollCount++;
            const elapsed = Math.round((Date.now() - startTime) / 1000);
            if (statusEl) {
                statusEl.textContent = `Waiting for confirmation... (${elapsed}s)`;
            }

            console.log(`[DEBUG] Polling SSH connection (${pollCount}/${MAX_POLLS})...`);
            const connected = await window.installer.invoke('test_ssh', {
                hostname: state.deviceIp
            });

            console.log('[DEBUG] SSH connected:', connected);
            if (connected) {
                clearInterval(confirmationPollInterval);
                confirmationPollInterval = null;
                console.log('[DEBUG] SSH confirmed, checking installation...');
                await checkIfInstalled();
                return;
            }

            // Timeout after MAX_POLLS attempts
            if (pollCount >= MAX_POLLS) {
                clearInterval(confirmationPollInterval);
                confirmationPollInterval = null;
                console.log('[DEBUG] SSH confirmation polling timed out');
                showConfirmationTimeout();
            }
        } catch (error) {
            console.error('Polling error:', error);
        }
    }, 2000); // Poll every 2 seconds
}

function cancelConfirmation() {
    if (confirmationPollInterval) {
        clearInterval(confirmationPollInterval);
        confirmationPollInterval = null;
    }
    showScreen('warning');
}

function showConfirmationTimeout() {
    const screen = document.getElementById('screen-confirm');
    const spinner = screen.querySelector('.spinner');
    if (spinner) spinner.style.display = 'none';

    const heading = screen.querySelector('h1');
    if (heading) heading.textContent = 'Connection Failed';

    const instructions = screen.querySelectorAll('.instruction');
    if (instructions[0]) {
        instructions[0].textContent = 'Could not establish SSH connection after 60 seconds.';
    }
    if (instructions[1]) {
        instructions[1].innerHTML = 'Make sure you confirmed "Yes" on your Move device, then try again.';
    }

    // Replace cancel button with retry + cancel + export logs
    const cancelBtn = document.getElementById('btn-cancel-confirm');
    if (cancelBtn) {
        const parent = cancelBtn.parentNode;

        const retryBtn = document.createElement('button');
        retryBtn.textContent = 'Retry';
        retryBtn.onclick = () => {
            // Restore original UI state
            if (spinner) spinner.style.display = '';
            if (heading) heading.textContent = 'Confirm on Device';
            if (instructions[0]) instructions[0].textContent = 'On your Ableton Move, use the jog wheel to select "Yes" and press to confirm';
            if (instructions[1]) instructions[1].textContent = 'Waiting for confirmation...';
            // Remove extra buttons
            const extraBtns = parent.querySelectorAll('.timeout-btn');
            extraBtns.forEach(b => b.remove());
            cancelBtn.style.display = '';
            // Restart polling
            startConfirmationPolling();
        };
        retryBtn.className = 'timeout-btn';
        parent.insertBefore(retryBtn, cancelBtn);

        const exportBtn = document.createElement('button');
        exportBtn.textContent = 'Export Debug Logs';
        exportBtn.className = 'secondary timeout-btn';
        exportBtn.onclick = exportLogs;
        parent.insertBefore(exportBtn, cancelBtn);

        cancelBtn.style.display = 'none';
    }
}

function cancelDiscovery() {
    // Reset state
    state.deviceIp = null;
    state.baseUrl = null;
    // Go back to warning screen
    showScreen('warning');
}

// Version / Installation Check
function updateVersionCheckStatus(message) {
    const statusEl = document.querySelector('#version-check-status .instruction');
    if (statusEl) {
        statusEl.textContent = message;
    }
}

async function checkIfInstalled() {
    try {
        showScreen('version-check');
        updateVersionCheckStatus('Checking installation...');

        const hostname = state.deviceIp;
        const coreCheck = await window.installer.invoke('check_core_installation', { hostname });

        if (!coreCheck.installed) {
            // Fresh install mode
            state.managementMode = false;
            document.querySelector('#screen-modules h1').textContent = 'Install Schwung';
            document.getElementById('btn-install').textContent = 'Install';
            const installOptions = document.querySelector('.install-options');
            if (installOptions) installOptions.style.display = 'block';
            document.getElementById('secondary-actions').style.display = 'none';
            document.getElementById('reenable-banner').style.display = 'none';
            const installedInfo = document.getElementById('installed-info');
            if (installedInfo) installedInfo.style.display = 'none';

            // Show version that will be installed
            const subtitle = document.getElementById('core-version-subtitle');
            try {
                const release = await window.installer.invoke('get_latest_release');
                if (release && release.version) {
                    subtitle.textContent = 'Version ' + release.version;
                    subtitle.style.display = '';
                }
            } catch (e) {
                subtitle.style.display = 'none';
            }

            document.querySelector('#screen-modules > .action-buttons').style.display = 'flex';
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
        const installOptions = document.querySelector('.install-options');
        if (installOptions) installOptions.style.display = 'none';
        document.getElementById('secondary-actions').style.display = 'flex';
        document.getElementById('reenable-banner').style.display = state.shimDisabled ? 'flex' : 'none';
        document.querySelector('#screen-modules > .action-buttons').style.display = 'none';
        const installedInfo = document.getElementById('installed-info');
        if (installedInfo) installedInfo.style.display = 'block';

        // Show version
        const subtitle = document.getElementById('core-version-subtitle');
        if (coreCheck.core) {
            subtitle.textContent = 'Version ' + coreCheck.core;
            subtitle.style.display = '';
        } else {
            subtitle.style.display = 'none';
        }

        showScreen('modules');
    } catch (error) {
        console.error('Install check failed:', error);
        state.managementMode = false;
        document.querySelector('#screen-modules h1').textContent = 'Install Schwung';
        const installOptions = document.querySelector('.install-options');
        if (installOptions) installOptions.style.display = 'block';
        document.getElementById('secondary-actions').style.display = 'none';
        document.getElementById('reenable-banner').style.display = 'none';
        document.querySelector('#screen-modules > .action-buttons').style.display = 'flex';
        showScreen('modules');
    }
}

// SSH Repair
async function startSshRepair() {
    showScreen('installing');
    try {
        initializeChecklist([]);
        const checklist = document.getElementById('install-checklist');
        checklist.innerHTML = `
            <div class="checklist-item" data-item-id="core">
                <div class="checklist-icon pending">\u25CB</div>
                <div class="checklist-item-text">Schwung Core (Repair)</div>
            </div>
        `;

        updateInstallProgress('Setting up SSH configuration...', 0);
        await window.installer.invoke('setup_ssh_config', { hostname: state.hostname });

        updateInstallProgress('Fetching latest release...', 5);
        const release = await window.installer.invoke('get_latest_release');

        updateChecklistItem('core', 'in-progress');
        updateInstallProgress(`Downloading ${release.asset_name}...`, 10);
        const tarballPath = await window.installer.invoke('download_release', {
            url: release.download_url,
            destPath: `/tmp/${release.asset_name}`
        });

        updateInstallProgress('Repairing Schwung core via SSH...', 30);
        await window.installer.invoke('install_main', {
            tarballPath,
            hostname: state.deviceIp,
            flags: []
        });
        updateChecklistItem('core', 'completed');

        updateInstallProgress('Repair complete!', 100);
        setTimeout(() => {
            populateSuccessScreen({ isRepair: true });
            showScreen('success');
        }, 500);
    } catch (error) {
        state.errors.push({ timestamp: new Date().toISOString(), message: error.toString() });
        showError('Repair failed: ' + error);
    }
}

// Installation
function initializeChecklist(modules) {
    const checklist = document.getElementById('install-checklist');
    const items = [];

    // Always add core item for fresh install
    items.push({
        id: 'core',
        name: 'Schwung Core',
        status: 'pending'
    });

    // Add module items
    modules.forEach(module => {
        items.push({
            id: module.id,
            name: module.name,
            status: 'pending'
        });
    });

    // Render checklist
    checklist.innerHTML = items.map(item => `
        <div class="checklist-item" data-item-id="${item.id}">
            <div class="checklist-icon pending">\u25CB</div>
            <div class="checklist-item-text">${item.name}</div>
        </div>
    `).join('');
}

function updateChecklistItem(itemId, status) {
    const item = document.querySelector(`.checklist-item[data-item-id="${itemId}"]`);
    if (!item) return;

    const icon = item.querySelector('.checklist-icon');

    // Remove old status classes
    item.classList.remove('pending', 'in-progress', 'completed');
    icon.classList.remove('pending', 'in-progress', 'completed');

    // Add new status
    item.classList.add(status);
    icon.classList.add(status);

    // Update icon
    if (status === 'pending') {
        icon.innerHTML = '\u25CB';
    } else if (status === 'in-progress') {
        icon.innerHTML = '<div class="spinner"></div>';
    } else if (status === 'completed') {
        icon.innerHTML = '\u2713';
    }
}

async function startInstallation() {
    showScreen('installing');
    try {
        // Core-only checklist
        initializeChecklist([]);

        updateInstallProgress('Setting up SSH configuration...', 0);
        await window.installer.invoke('setup_ssh_config', { hostname: state.hostname });

        updateInstallProgress('Fetching latest release...', 10);
        const release = await window.installer.invoke('get_latest_release');

        updateInstallProgress('Downloading ' + release.asset_name + '...', 20);
        const tarballPath = await window.installer.invoke('download_release', {
            url: release.download_url,
            destPath: '/tmp/' + release.asset_name
        });

        const installFlags = [];
        if (state.enableScreenReader) installFlags.push('--enable-screen-reader');

        updateChecklistItem('core', 'in-progress');
        updateInstallProgress('Installing Schwung...', 40);
        await window.installer.invoke('install_main', {
            tarballPath: tarballPath,
            hostname: state.deviceIp,
            flags: installFlags
        });
        updateChecklistItem('core', 'completed');

        updateInstallProgress('Installation complete!', 100);
        setTimeout(function() {
            populateSuccessScreen();
            showScreen('success');
        }, 500);
    } catch (error) {
        state.errors.push({ timestamp: new Date().toISOString(), message: error.toString() });
        showError('Installation failed: ' + error);
    }
}

function populateSuccessScreen(options = {}) {
    const { isUninstall = false, isReenable = false, isRepair = false } = options;
    const container = document.getElementById('success-next-steps');
    const backBtn = document.getElementById('btn-back-manage');
    const instructionEl = document.querySelector('#screen-success .instruction');

    const startOverBtn = document.getElementById('btn-start-over');

    const restartNotice = '<p style="margin-top: 1rem; color: #b8b8b8;">The web servers are restarting. After 60 seconds, access Schwung Manager at <a href="http://schwung.local" target="_blank" style="color: #0066cc;">http://schwung.local</a></p>';

    if (isReenable) {
        document.querySelector('#screen-success h1').textContent = 'Re-enabled!';
        instructionEl.textContent = 'Schwung has been re-enabled. All your modules and settings are intact.';
        container.innerHTML = restartNotice;
        container.style.display = '';
        backBtn.style.display = '';
        startOverBtn.style.display = 'none';
        state.shimDisabled = false;
        return;
    }

    if (isUninstall) {
        document.querySelector('#screen-success h1').textContent = 'Uninstall Complete';
        instructionEl.textContent = 'Schwung has been removed from your device.';
        container.innerHTML = '<p>You can reinstall Schwung by clicking "Start Over" below.</p>';
        container.style.display = '';
        backBtn.style.display = 'none';
        startOverBtn.style.display = '';
        return;
    }
    startOverBtn.style.display = 'none';

    if (isRepair) {
        document.querySelector('#screen-success h1').textContent = 'Repair Complete';
        instructionEl.textContent = 'Schwung core has been reinstalled successfully.';
        container.innerHTML = restartNotice;
        container.style.display = '';
        backBtn.style.display = 'none';
        startOverBtn.style.display = '';
        return;
    }

    // Fresh install
    document.querySelector('#screen-success h1').textContent = "You're All Set!";
    instructionEl.textContent = 'Schwung has been successfully installed on your device.';
    backBtn.style.display = '';

    let html = '<p><strong>Getting Started:</strong></p>';
    html += '<ul style="margin: 0.5rem 0 0 1.5rem; color: #b8b8b8; list-style: none; padding: 0;">';

    html += '<li style="margin: 0.5rem 0;"><strong style="color: #0066cc;">Shift + Vol + Track</strong> or <strong style="color: #0066cc;">Shift + Vol + Menu</strong> &mdash; Access track and master slots</li>';
    html += '<li style="margin: 0.5rem 0;"><strong style="color: #0066cc;">Shift + Vol + Jog Click</strong> &mdash; Access overtake modules</li>';

    if (state.enableScreenReader) {
        html += '<li style="margin: 0.5rem 0;"><strong style="color: #0066cc;">Shift + Menu</strong> &mdash; Toggle screen reader on and off</li>';
    }

    html += '</ul>';
    html += '<p style="margin-top: 1rem;"><a href="https://github.com/charlesvestal/schwung/blob/main/MANUAL.md" target="_blank" style="color: #0066cc;">Read the full manual</a></p>';
    html += restartNotice;
    container.innerHTML = html;
    container.style.display = '';
}

function updateInstallProgress(message, percent) {
    const progressStatus = document.getElementById('install-status');
    if (progressStatus) {
        progressStatus.textContent = message;
    }

    if (percent !== undefined) {
        const progressFill = document.querySelector('.progress-fill');
        if (progressFill) {
            progressFill.style.width = `${percent}%`;
        }
    }

    console.log('Install progress:', message, percent !== undefined ? `${percent}%` : '');
}

// Error Handling
function parseError(error) {
    const errorStr = error.toString().toLowerCase();

    // Network/connectivity errors
    if (errorStr.includes('timeout') || errorStr.includes('econnrefused') || errorStr.includes('ehostunreach')) {
        return {
            title: 'Connection Failed',
            message: 'Could not connect to your Move device.',
            suggestions: [
                'Check that your Move is powered on',
                'Ensure your Move is connected to the same WiFi network',
                'Try restarting your Move',
                'Check your WiFi connection'
            ]
        };
    }

    if (errorStr.includes('dns') || errorStr.includes('getaddrinfo') || errorStr.includes('.local')) {
        return {
            title: 'Device Not Found',
            message: 'Could not find your Move on the network.',
            suggestions: [
                'Try entering your Move\'s IP address manually',
                'Check that your Move is connected to WiFi',
                'Make sure you\'re on the same WiFi network as your Move',
                'On Windows, install Bonjour service (comes with iTunes/iCloud)'
            ]
        };
    }

    // Download errors
    if (errorStr.includes('download') || errorStr.includes('404') || errorStr.includes('fetch failed')) {
        return {
            title: 'Download Failed',
            message: 'Could not download required files.',
            suggestions: [
                'Check your internet connection',
                'Try again in a few moments',
                'Verify GitHub is accessible from your network'
            ]
        };
    }

    // Authentication errors
    if (errorStr.includes('auth') || errorStr.includes('unauthorized') || errorStr.includes('challenge')) {
        return {
            title: 'Authentication Failed',
            message: 'Could not authenticate with your Move.',
            suggestions: [
                'The authorization code may have expired',
                'Try restarting the installer',
                'Make sure you entered the correct code from your Move display'
            ]
        };
    }

    // File permission errors (root-owned directories on device)
    if (errorStr.includes('permission denied') && (errorStr.includes('sftp') || errorStr.includes('module') || errorStr.includes('mkdir') || errorStr.includes('tar'))) {
        return {
            title: 'Permission Error',
            message: 'Could not write to the Schwung directory on your device.',
            suggestions: [
                'Some files on the device may be owned by root from a previous install',
                'Try "Repair Installation" from the menu to fix permissions',
                'Or SSH in as root and run: chown -R ableton:ableton /data/UserData/schwung'
            ]
        };
    }

    // Connection setup errors
    if (errorStr.includes('key') || errorStr.includes('permission denied')) {
        return {
            title: 'Connection Setup Failed',
            message: 'Could not set up secure connection to your Move.',
            suggestions: [
                'Make sure you confirmed "Yes" on your Move device',
                'Try the setup process again',
                'Restart your Move and try again'
            ]
        };
    }

    // Disk space errors
    if (errorStr.includes('enospc') || errorStr.includes('no space')) {
        return {
            title: 'Disk Full',
            message: 'Not enough space on your Move device.',
            canCleanTmp: true,
            suggestions: [
                'Click "Clean Up & Retry" below to remove temp files from your device and try again',
                'Free up space by deleting unused samples or sets'
            ]
        };
    }

    // Generic fallback
    return {
        title: 'Installation Error',
        message: error.toString(),
        suggestions: [
            'Try restarting the installer',
            'Check that your Move has the latest firmware',
            'Copy diagnostics and report the issue on GitHub'
        ]
    };
}

function showError(message) {
    const parsed = parseError(message);

    state.errors.push({
        timestamp: new Date().toISOString(),
        message: message
    });

    showScreen('error');

    const errorDiv = document.getElementById('error-message');
    errorDiv.innerHTML = `
        <h3 style="margin: 0 0 1rem 0; color: #ff6666;">${parsed.title}</h3>
        <p style="margin: 0 0 1rem 0;">${parsed.message}</p>
        <div style="margin-top: 1.5rem;">
            <strong style="color: #fff;">What to try:</strong>
            <ul style="margin: 0.5rem 0 0 1.5rem; color: #b8b8b8;">
                ${parsed.suggestions.map(s => `<li style="margin: 0.5rem 0;">${s}</li>`).join('')}
            </ul>
        </div>
    `;

    // Show cleanup button for disk-full errors
    const cleanupBtn = document.getElementById('btn-clean-retry');
    if (cleanupBtn) {
        cleanupBtn.style.display = parsed.canCleanTmp ? '' : 'none';
    }
}

function retryInstallation() {
    state.currentScreen = 'discovery';
    state.deviceIp = null;
    state.authCode = null;
    state.sshPassword = null;
    state.errors = [];

    showScreen('discovery');
    startDeviceDiscovery();
}

// Utility Functions
function closeApplication() {
    window.close();
}

// --- WiFi Manager State ---
const wifiManager = {
    open: false,
    loading: false,
    networks: [],
    isUsbConnection: false,
    passwordTarget: null
};

// --- WiFi Manager Functions ---

async function openWifiManager() {
    wifiManager.open = true;
    wifiManager.networks = [];
    wifiManager.passwordTarget = null;
    document.getElementById('wifi-modal').style.display = 'flex';
    document.getElementById('wifi-network-view').style.display = '';
    document.getElementById('wifi-password-view').style.display = 'none';
    document.getElementById('wifi-disabled-view').style.display = 'none';
    document.getElementById('wifi-warning').style.display = 'none';
    document.getElementById('wifi-network-list').innerHTML = '';
    setWifiStatus('Checking WiFi status...', '');

    try {
        const hostname = state.deviceIp;
        const status = await window.installer.invoke('wifi_get_status', { hostname });
        wifiManager.isUsbConnection = status.isUsbConnection;

        if (!status.isUsbConnection) {
            document.getElementById('wifi-warning').style.display = '';
        }

        if (!status.wifiEnabled) {
            document.getElementById('wifi-network-view').style.display = 'none';
            document.getElementById('wifi-disabled-view').style.display = '';
            setWifiStatus('WiFi is disabled', 'disconnected');
            return;
        }

        if (status.connectedService) {
            setWifiStatus(`Connected to ${status.connectedService.name}`, 'connected');
        } else {
            setWifiStatus('Not connected', 'disconnected');
        }

        wifiDoScan();
    } catch (err) {
        setWifiStatus(`Error: ${err.message}`, 'error');
    }
}

function closeWifiManager() {
    wifiManager.open = false;
    wifiManager.passwordTarget = null;
    document.getElementById('wifi-modal').style.display = 'none';
}

function setWifiStatus(text, cssClass) {
    const dot = document.getElementById('wifi-status-dot');
    const textEl = document.getElementById('wifi-status-text');
    dot.className = 'wifi-status-dot' + (cssClass ? ' ' + cssClass : '');
    textEl.textContent = text;
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

async function wifiDoScan() {
    const scanBtn = document.getElementById('wifi-scan-btn');
    scanBtn.disabled = true;
    scanBtn.textContent = 'Scanning...';
    document.getElementById('wifi-status').textContent = 'Scanning for networks...';

    try {
        const hostname = state.deviceIp;
        const networks = await window.installer.invoke('wifi_scan', { hostname });
        wifiManager.networks = networks;
        showWifiNetworkList(networks);
        document.getElementById('wifi-status').textContent = `Found ${networks.length} network(s)`;
        // Update status bar based on connected network
        const connected = networks.find(n => n.connected);
        if (connected) {
            setWifiStatus(`Connected to ${connected.name}`, 'connected');
        } else {
            setWifiStatus('Not connected', 'disconnected');
        }
    } catch (err) {
        document.getElementById('wifi-status').textContent = `Scan failed: ${err.message}`;
        setWifiStatus('Error', 'error');
    } finally {
        scanBtn.disabled = false;
        scanBtn.textContent = 'Scan for Networks';
    }
}

function showWifiNetworkList(networks) {
    const list = document.getElementById('wifi-network-list');
    // Sort: connected first, then saved, then alphabetical
    const sorted = [...networks].sort((a, b) => {
        if (a.connected !== b.connected) return a.connected ? -1 : 1;
        if (a.saved !== b.saved) return a.saved ? -1 : 1;
        return a.name.localeCompare(b.name);
    });

    list.innerHTML = sorted.map(n => {
        const safeName = escapeHtml(n.name);
        const safeServiceId = escapeHtml(n.serviceId);
        const icon = n.connected ? '&#10003;' : (n.security !== 'open' ? '&#128274;' : '&#8226;');
        const details = [];
        if (n.connected) details.push('Connected');
        else if (n.saved) details.push('Saved');
        if (n.security !== 'open') details.push(escapeHtml(n.security));
        else details.push('Open');

        let actions = '';
        if (n.connected) {
            actions = `<button data-action="disconnect" data-service="${safeServiceId}">Disconnect</button>`;
        } else if (n.security === 'Enterprise') {
            actions = `<span style="color: #666; font-size: 0.75rem;">Enterprise</span>`;
        } else if (n.name === '(Hidden Network)') {
            actions = `<span style="color: #666; font-size: 0.75rem;">Hidden</span>`;
        } else {
            actions = `<button data-action="connect" data-service="${safeServiceId}" data-name="${safeName}" data-security="${escapeHtml(n.security)}" data-saved="${n.saved}">Connect</button>`;
        }
        if (n.saved && !n.connected) {
            actions += `<button data-action="forget" data-service="${safeServiceId}" data-name="${safeName}">Forget</button>`;
        }

        return `<div class="wifi-network-entry${n.connected ? ' connected' : ''}">
            <div class="wifi-network-icon">${icon}</div>
            <div class="wifi-network-info">
                <div class="wifi-network-name">${safeName}</div>
                <div class="wifi-network-detail">${details.join(' \u00b7 ')}</div>
            </div>
            <div class="wifi-network-actions">${actions}</div>
        </div>`;
    }).join('');

    // Attach event listeners
    list.querySelectorAll('button[data-action]').forEach(btn => {
        btn.onclick = () => {
            const action = btn.dataset.action;
            const serviceId = btn.dataset.service;
            const name = btn.dataset.name;
            const security = btn.dataset.security;
            const saved = btn.dataset.saved === 'true';
            if (action === 'connect') {
                wifiConnectToNetwork({ serviceId, name, security, saved });
            } else if (action === 'disconnect') {
                wifiDisconnect({ serviceId, name });
            } else if (action === 'forget') {
                wifiForgetNetwork({ serviceId, name });
            }
        };
    });
}

function wifiConnectToNetwork(network) {
    if (!wifiManager.isUsbConnection) {
        if (!confirm('You appear to be connected via WiFi. Changing networks may disconnect this session. Continue?')) {
            return;
        }
    }
    // If secured and not saved, show password form
    if (network.security !== 'open' && !network.saved) {
        wifiManager.passwordTarget = network;
        document.getElementById('wifi-password-network-name').textContent = network.name;
        document.getElementById('wifi-password-input').value = '';
        document.getElementById('wifi-network-view').style.display = 'none';
        document.getElementById('wifi-password-view').style.display = '';
        setTimeout(() => document.getElementById('wifi-password-input').focus(), 100);
        return;
    }
    wifiDoConnect(network.serviceId, null, network.name);
}

async function wifiDoConnect(serviceId, passphrase, name) {
    document.getElementById('wifi-status').textContent = `Connecting to ${name}...`;
    try {
        const hostname = state.deviceIp;
        await window.installer.invoke('wifi_connect', { hostname, serviceId, passphrase });
        document.getElementById('wifi-status').textContent = `Connected to ${name}`;
        setWifiStatus(`Connected to ${name}`, 'connected');
    } catch (err) {
        document.getElementById('wifi-status').textContent = `Connection failed: ${err.message}`;
        setWifiStatus('Connection failed', 'error');
    }
    // Refresh list after delay (SSH may have dropped and reconnected)
    setTimeout(async () => {
        try {
            const hostname = state.deviceIp;
            const networks = await window.installer.invoke('wifi_list_services', { hostname });
            wifiManager.networks = networks;
            showWifiNetworkList(networks);
            const connected = networks.find(n => n.connected);
            if (connected) {
                setWifiStatus(`Connected to ${connected.name}`, 'connected');
            }
        } catch (err) {
            document.getElementById('wifi-status').textContent = 'Could not refresh — SSH session may have dropped. Close and reopen WiFi to retry.';
        }
    }, 2000);
}

function wifiPasswordSubmit() {
    const passphrase = document.getElementById('wifi-password-input').value;
    if (!passphrase) return;
    const target = wifiManager.passwordTarget;
    wifiManager.passwordTarget = null;
    document.getElementById('wifi-password-view').style.display = 'none';
    document.getElementById('wifi-network-view').style.display = '';
    wifiDoConnect(target.serviceId, passphrase, target.name);
}

function wifiPasswordCancel() {
    wifiManager.passwordTarget = null;
    document.getElementById('wifi-password-view').style.display = 'none';
    document.getElementById('wifi-network-view').style.display = '';
}

async function wifiDisconnect(network) {
    if (!wifiManager.isUsbConnection) {
        if (!confirm('You appear to be connected via WiFi. Disconnecting may drop this session. Continue?')) {
            return;
        }
    }
    document.getElementById('wifi-status').textContent = `Disconnecting from ${network.name || 'network'}...`;
    try {
        const hostname = state.deviceIp;
        await window.installer.invoke('wifi_disconnect', { hostname, serviceId: network.serviceId });
        document.getElementById('wifi-status').textContent = 'Disconnected';
        setWifiStatus('Not connected', 'disconnected');
    } catch (err) {
        document.getElementById('wifi-status').textContent = `Disconnect failed: ${err.message}`;
    }
    setTimeout(async () => {
        try {
            const hostname = state.deviceIp;
            const networks = await window.installer.invoke('wifi_list_services', { hostname });
            wifiManager.networks = networks;
            showWifiNetworkList(networks);
        } catch (err) {
            console.log('[WIFI] Failed to refresh after disconnect:', err.message);
        }
    }, 1500);
}

async function wifiForgetNetwork(network) {
    if (!confirm(`Forget "${network.name}"? You will need to re-enter the password to connect again.`)) return;
    document.getElementById('wifi-status').textContent = `Removing ${network.name}...`;
    try {
        const hostname = state.deviceIp;
        await window.installer.invoke('wifi_remove_service', { hostname, serviceId: network.serviceId });
        document.getElementById('wifi-status').textContent = `Removed ${network.name}`;
    } catch (err) {
        document.getElementById('wifi-status').textContent = `Remove failed: ${err.message}`;
    }
    try {
        const hostname = state.deviceIp;
        const networks = await window.installer.invoke('wifi_list_services', { hostname });
        wifiManager.networks = networks;
        showWifiNetworkList(networks);
    } catch (err) {
        console.log('[WIFI] Failed to refresh after forget:', err.message);
    }
}

async function wifiEnableRadio() {
    const btn = document.getElementById('wifi-enable-btn');
    btn.disabled = true;
    btn.textContent = 'Enabling...';
    try {
        const hostname = state.deviceIp;
        await window.installer.invoke('wifi_enable_radio', { hostname });
        document.getElementById('wifi-disabled-view').style.display = 'none';
        document.getElementById('wifi-network-view').style.display = '';
        setWifiStatus('WiFi enabled', 'disconnected');
        wifiDoScan();
    } catch (err) {
        document.getElementById('wifi-status').textContent = `Failed to enable WiFi: ${err.message}`;
    } finally {
        btn.disabled = false;
        btn.textContent = 'Enable WiFi';
    }
}

// Event Listeners
document.addEventListener('DOMContentLoaded', async () => {
    console.log('[DEBUG] DOM loaded, installer API available:', !!window.installer);

    // Listen for backend logs
    window.installer.on('backend-log', (message) => {
        console.log('[BACKEND]', message);
        addLog('BACKEND', message);
    });

    // Capture frontend console.log too
    const origConsoleLog = console.log;
    const origConsoleError = console.error;
    console.log = function(...args) {
        origConsoleLog.apply(console, args);
        addLog('UI', args.join(' '));
    };
    console.error = function(...args) {
        origConsoleError.apply(console, args);
        addLog('UI:ERROR', args.join(' '));
    };

    // Check if returning user and soften warning
    try {
        const savedCookie = await window.installer.invoke('get_saved_cookie');
        if (savedCookie) {
            document.getElementById('warning-title').textContent = 'Schwung Installer';
            document.getElementById('warning-box').innerHTML = `
                <p><strong>Welcome back!</strong> This installer will connect to your Ableton Move to manage your installation.</p>
                <p><strong>Note:</strong> Ensure your Move is connected to the same WiFi network as this computer.</p>
            `;
        }
    } catch (e) { /* ignore */ }

    // Check for installer updates
    try {
        const update = await window.installer.invoke('check_installer_update');
        if (update && update.updateAvailable) {
            const banner = document.getElementById('update-banner');
            document.getElementById('update-banner-text').textContent =
                `A new installer version (v${update.latestVersion}) is available.`;
            const link = document.getElementById('update-banner-link');
            link.href = update.url;
            banner.style.display = 'block';
        }
    } catch (e) { /* non-critical */ }

    // Warning screen
    document.getElementById('btn-accept-warning').onclick = async (e) => {
        // Hidden test mode: Shift+Click to run SSH format tests
        if (e.shiftKey) {
            console.log('[DEBUG] Running SSH format tests...');
            alert('Running SSH format tests... Check console for results.');
            try {
                const cookie = await window.installer.invoke('get_saved_cookie');
                const results = await window.installer.invoke('test_ssh_formats', { cookie });
                console.log('[TEST RESULTS]', JSON.stringify(results, null, 2));
                alert(`Test complete! Results:\n\n${JSON.stringify(results, null, 2)}`);
            } catch (err) {
                console.error('[TEST ERROR]', err);
                alert(`Test failed: ${err.message}`);
            }
            return;
        }

        showScreen('discovery');
        startDeviceDiscovery();
    };

    document.getElementById('btn-cancel').onclick = () => {
        closeApplication();
    };

    // Discovery screen
    document.getElementById('btn-manual-connect').onclick = () => {
        const ip = document.getElementById('manual-ip').value.trim();
        if (ip) {
            selectDevice(ip);
        }
    };

    // Allow Enter key to connect from manual IP input
    document.getElementById('manual-ip').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            const ip = e.target.value.trim();
            if (ip) {
                selectDevice(ip);
            }
        }
    });

    // Discovery screen
    document.getElementById('btn-cancel-discovery').onclick = cancelDiscovery;

    // Code entry screen
    document.getElementById('btn-submit-code').onclick = submitAuthCode;
    document.getElementById('btn-back-discovery').onclick = () => showScreen('discovery');

    // SSH Key screen
    document.getElementById('btn-add-ssh-key').onclick = () => proceedToSshSetup(state.baseUrl);
    document.getElementById('btn-back-ssh-key').onclick = () => showScreen('code-entry');

    // Confirm screen
    document.getElementById('btn-cancel-confirm').onclick = cancelConfirmation;

    // Secondary action links
    document.getElementById('link-screenreader').onclick = async (e) => {
        e.preventDefault();
        const link = e.target;
        const originalText = link.textContent;
        try {
            const hostname = state.deviceIp;

            link.textContent = 'Checking...';
            link.style.pointerEvents = 'none';

            const currentStatus = await window.installer.invoke('get_screen_reader_status', { hostname });

            const action = currentStatus ? 'disable' : 'enable';
            const confirmMsg = currentStatus
                ? 'Screen reader is currently enabled. Disable it?'
                : 'Screen reader is currently disabled. Enable it?';

            if (!confirm(confirmMsg)) {
                link.textContent = originalText;
                link.style.pointerEvents = '';
                return;
            }

            link.textContent = `${action === 'enable' ? 'Enabling' : 'Disabling'}...`;

            const result = await window.installer.invoke('set_screen_reader_state', {
                hostname,
                enabled: !currentStatus
            });

            link.textContent = result.message || 'Done';
            setTimeout(() => {
                link.textContent = originalText;
                link.style.pointerEvents = '';
            }, 2000);
        } catch (error) {
            console.error('Failed to toggle screen reader:', error);
            link.textContent = 'Failed';
            setTimeout(() => {
                link.textContent = originalText;
                link.style.pointerEvents = '';
            }, 2000);
        }
    };

    document.getElementById('btn-reenable').onclick = async (e) => {
        e.preventDefault();
        if (!confirm('Re-enable Schwung?\n\nThis will restore the shim hooks on the root partition. No downloads needed — all your modules and settings are already on the device.')) return;

        showScreen('installing');
        try {
            const checklist = document.getElementById('install-checklist');
            checklist.innerHTML = `
                <div class="checklist-item" data-item-id="reenable">
                    <div class="checklist-icon pending">\u25CB</div>
                    <div class="checklist-item-text">Re-enable Schwung</div>
                </div>
            `;

            updateChecklistItem('reenable', 'in-progress');
            updateInstallProgress('Re-enabling Schwung...', 20);

            const hostname = state.deviceIp;
            await window.installer.invoke('reenable_move_everything', { hostname });

            updateChecklistItem('reenable', 'completed');
            updateInstallProgress('Re-enable complete!', 100);

            setTimeout(() => {
                populateSuccessScreen({ isReenable: true });
                showScreen('success');
            }, 500);
        } catch (error) {
            const errorText = String(error);
            state.errors.push({
                timestamp: new Date().toISOString(),
                message: errorText
            });

            const payloadMissing =
                errorText.includes('Shim not found on data partition') ||
                errorText.includes('Entrypoint not found on data partition');

            if (payloadMissing) {
                const shouldReinstall = confirm(
                    'Re-enable cannot continue because the core payload is missing from /data/UserData/schwung.\n\nReinstall Schwung core now?'
                );
                if (shouldReinstall) {
                    // Reinstall core via startSshRepair-like flow
                    await startSshRepair();
                    return;
                }
            }

            showError('Re-enable failed: ' + error);
        }
    };

    document.getElementById('link-repair').onclick = async (e) => {
        e.preventDefault();

        if (!confirm('Repair installation? This will reinstall Schwung core.')) return;

        showScreen('installing');
        try {
            // Build checklist - core only
            const checklist = document.getElementById('install-checklist');
            checklist.innerHTML = `
                <div class="checklist-item" data-item-id="core">
                    <div class="checklist-icon pending">\u25CB</div>
                    <div class="checklist-item-text">Schwung Core</div>
                </div>
            `;

            updateInstallProgress('Setting up SSH configuration...', 0);
            await window.installer.invoke('setup_ssh_config', { hostname: state.hostname });

            // Reinstall core
            updateInstallProgress('Fetching latest release...', 5);
            const release = await window.installer.invoke('get_latest_release');

            updateChecklistItem('core', 'in-progress');
            updateInstallProgress(`Downloading ${release.asset_name}...`, 10);
            const coreTarball = await window.installer.invoke('download_release', {
                url: release.download_url,
                destPath: `/tmp/${release.asset_name}`
            });

            updateInstallProgress('Reinstalling Schwung core...', 30);
            const installFlags = [];
            if (state.enableScreenReader) installFlags.push('--enable-screen-reader');

            await window.installer.invoke('install_main', {
                tarballPath: coreTarball,
                hostname: state.deviceIp,
                flags: installFlags
            });
            updateChecklistItem('core', 'completed');

            // Fix permissions
            updateInstallProgress('Fixing file permissions...', 80);
            await window.installer.invoke('fix_permissions', { hostname: state.deviceIp });

            updateInstallProgress('Repair complete!', 100);
            setTimeout(() => {
                populateSuccessScreen({ isRepair: true });
                showScreen('success');
            }, 500);
        } catch (error) {
            state.errors.push({ timestamp: new Date().toISOString(), message: error.toString() });
            showError('Repair failed: ' + error);
        }
    };

    document.getElementById('link-uninstall').onclick = async (e) => {
        e.preventDefault();
        if (confirm('Are you sure you want to uninstall Schwung? This will restore your Move to stock firmware.')) {
            try {
                const hostname = state.deviceIp;
                updateInstallProgress('Uninstalling Schwung...', 50);
                showScreen('installing');

                const result = await window.installer.invoke('uninstall_move_everything', { hostname });

                updateInstallProgress('Complete!', 100);

                // Show success message
                setTimeout(() => {
                    populateSuccessScreen({ isUninstall: true });
                    showScreen('success');
                }, 500);
            } catch (error) {
                console.error('Uninstall failed:', error);
                showError('Uninstall failed: ' + error.message);
            }
        }
    };

    // Module selection screen
    document.getElementById('btn-install').onclick = startInstallation;
    document.getElementById('btn-back-modules').onclick = () => {
        showScreen('warning');
    };

    // Success screen
    document.getElementById('btn-done').onclick = closeApplication;
    document.getElementById('btn-back-manage').onclick = () => checkIfInstalled();
    document.getElementById('btn-start-over').onclick = () => {
        // Reset state for fresh install
        state.managementMode = false;
        showScreen('discovery');
        startDeviceDiscovery();
    };

    // Error screen
    document.getElementById('btn-clean-retry').onclick = async () => {
        const btn = document.getElementById('btn-clean-retry');
        btn.textContent = 'Cleaning...';
        btn.disabled = true;
        try {
            const result = await window.installer.invoke('clean_device_tmp', { hostname: state.deviceIp });
            btn.textContent = `Freed ${result.freedMB}MB — retrying...`;
            setTimeout(() => retryInstallation(), 1000);
        } catch (err) {
            console.error('Cleanup failed:', err);
            btn.textContent = 'Cleanup failed';
            btn.disabled = false;
        }
    };
    document.getElementById('btn-retry').onclick = retryInstallation;
    document.getElementById('btn-diagnostics').onclick = async () => {
        try {
            const errorMessages = state.errors.map(e => `[${e.timestamp}] ${e.message}`);
            const report = await window.installer.invoke('get_diagnostics', {
                deviceIp: state.deviceIp,
                errors: errorMessages
            });

            await navigator.clipboard.writeText(report);
            alert('Diagnostics copied to clipboard');
        } catch (error) {
            console.error('Failed to generate diagnostics:', error);
            alert('Failed to copy diagnostics: ' + error);
        }
    };

    // Export logs buttons
    document.getElementById('btn-export-logs').onclick = (e) => { e.preventDefault(); exportLogs(); };
    document.getElementById('btn-export-logs-error').onclick = exportLogs;

    // Close modal on Escape key
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            if (wifiManager.open) closeWifiManager();
        }
    });

    // WiFi manager events
    document.getElementById('link-wifi').onclick = (e) => {
        e.preventDefault();
        openWifiManager();
    };
    document.getElementById('wifi-modal-close').onclick = closeWifiManager;
    document.getElementById('wifi-scan-btn').onclick = wifiDoScan;
    document.getElementById('wifi-enable-btn').onclick = wifiEnableRadio;
    document.getElementById('wifi-password-connect').onclick = wifiPasswordSubmit;
    document.getElementById('wifi-password-cancel').onclick = wifiPasswordCancel;
    document.getElementById('wifi-modal').onclick = (e) => {
        if (e.target.id === 'wifi-modal') closeWifiManager();
    };
    document.getElementById('wifi-password-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') wifiPasswordSubmit();
    });

    // Start on warning screen - user must accept before proceeding
    console.log('[DEBUG] DOM loaded, showing warning');
});
