const axios = require('axios');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dns = require('dns');
const crypto = require('crypto');
const { Client } = require('ssh2');
const { promisify } = require('util');
const mkdir = promisify(fs.mkdir);
const writeFile = promisify(fs.writeFile);
const readFile = promisify(fs.readFile);
const copyFile = promisify(fs.copyFile);
const access = promisify(fs.access);
const rm = promisify(fs.rm);
const dnsResolve4 = promisify(dns.resolve4);

// State management
let savedCookie = null;
const cookieStore = path.join(os.homedir(), '.schwung-installer-cookie');

// Store reference to main window for logging
let mainWindowForLogging = null;

function setMainWindow(win) {
    mainWindowForLogging = win;
}

// Override console.log to also send to renderer
const originalLog = console.log;
console.log = function(...args) {
    originalLog.apply(console, args);
    if (mainWindowForLogging && !mainWindowForLogging.isDestroyed() && mainWindowForLogging.webContents) {
        mainWindowForLogging.webContents.send('backend-log', args.join(' '));
    }
};

const originalError = console.error;
console.error = function(...args) {
    originalError.apply(console, args);
    if (mainWindowForLogging && !mainWindowForLogging.isDestroyed() && mainWindowForLogging.webContents) {
        mainWindowForLogging.webContents.send('backend-log', '[ERROR] ' + args.join(' '));
    }
};

// HTTP client with cookie support
const httpClient = axios.create({
    timeout: 60000, // 60 seconds for user interactions
    validateStatus: () => true, // Don't throw on non-2xx status
    family: 4 // Force IPv4
});

// Load saved cookie on startup
(async () => {
    try {
        if (fs.existsSync(cookieStore)) {
            savedCookie = await readFile(cookieStore, 'utf-8');
        }
    } catch (err) {
        console.error('Failed to load saved cookie:', err);
    }
})();

// Cache device IP for current session only (not persisted between runs)
let cachedDeviceIp = null;

function clearDnsCache() {
    // Reset the in-process cached IP so the next validateDevice does a fresh DNS lookup
    console.log('[DEBUG] Clearing cached device IP (was:', cachedDeviceIp, ')');
    cachedDeviceIp = null;
}

async function validateDevice(baseUrl) {
    try {
        // Extract hostname from baseUrl
        const url = new URL(baseUrl);
        const hostname = url.hostname;

        // Check if hostname is already an IP address
        const isIpAddress = /^\d+\.\d+\.\d+\.\d+$/.test(hostname);

        // If we already have a cached IP, use it (don't reset for same device)
        // Only reset if user explicitly enters a DIFFERENT IP address
        if (cachedDeviceIp) {
            if (isIpAddress && cachedDeviceIp !== hostname) {
                console.log(`[DEBUG] User entered different IP, resetting cache (was ${cachedDeviceIp}, now ${hostname})`);
                cachedDeviceIp = null;
            } else {
                console.log(`[DEBUG] Using cached IP: ${cachedDeviceIp}`);
                // Don't resolve again, use cached IP
            }
        }

        // For .local domains or non-IP hostnames, resolve to IP first
        if (!cachedDeviceIp) {
            if (isIpAddress) {
                // Already an IP, use it directly
                console.log(`[DEBUG] Using IP address directly: ${hostname}`);
                cachedDeviceIp = hostname;
            } else {
                // Try DNS resolution
                try {
                    console.log(`[DEBUG] Resolving ${hostname} to IP...`);

                    if (process.platform === 'win32') {
                        // Windows: Try multiple resolution methods for .local domains
                        const { exec } = require('child_process');
                        const { promisify } = require('util');
                        const execAsync = promisify(exec);

                        const resolvers = [
                            {
                                name: 'dns.lookup',
                                fn: async () => {
                                    const dns = require('dns');
                                    return new Promise((resolve, reject) => {
                                        const timer = setTimeout(() => reject(new Error('dns.lookup timed out')), 5000);
                                        dns.lookup(hostname, { family: 4 }, (err, address) => {
                                            clearTimeout(timer);
                                            if (err) reject(err);
                                            else resolve(address);
                                        });
                                    });
                                }
                            },
                            {
                                name: 'ping',
                                fn: async () => {
                                    const { stdout } = await execAsync(`ping -n 1 ${hostname}`, { timeout: 5000 });
                                    let ipMatch = stdout.match(/\[?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\]?/);
                                    if (ipMatch) return ipMatch[1];
                                    ipMatch = stdout.match(/\[([0-9a-f:]+)\]/i);
                                    if (ipMatch) return `[${ipMatch[1]}]`;
                                    throw new Error('Could not parse IP from ping output');
                                }
                            },
                            {
                                name: 'Resolve-DnsName',
                                fn: async () => {
                                    const { stdout } = await execAsync(
                                        `powershell -Command "(Resolve-DnsName '${hostname}' -Type A -ErrorAction Stop | Select-Object -First 1).IPAddress"`,
                                        { timeout: 8000 }
                                    );
                                    const ip = stdout.trim();
                                    if (!ip || !/^\d+\.\d+\.\d+\.\d+$/.test(ip)) throw new Error('No IPv4 from Resolve-DnsName');
                                    return ip;
                                }
                            },
                            {
                                name: 'dns-sd',
                                fn: async () => {
                                    // dns-sd is available if Bonjour/iTunes is installed
                                    // It runs continuously, so we spawn it and resolve as soon as we see an IP
                                    const { spawn } = require('child_process');
                                    return new Promise((resolve, reject) => {
                                        const proc = spawn('dns-sd', ['-G', 'v4', hostname]);
                                        let output = '';
                                        const timeout = setTimeout(() => {
                                            proc.kill();
                                            reject(new Error('dns-sd timed out'));
                                        }, 5000);
                                        proc.stdout.on('data', (data) => {
                                            output += data.toString();
                                            const ipMatch = output.match(/\s(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})[\s\r\n]/);
                                            if (ipMatch) {
                                                clearTimeout(timeout);
                                                proc.kill();
                                                resolve(ipMatch[1]);
                                            }
                                        });
                                        proc.on('error', (err) => {
                                            clearTimeout(timeout);
                                            reject(err);
                                        });
                                    });
                                }
                            }
                        ];

                        let resolved = false;
                        for (const resolver of resolvers) {
                            try {
                                console.log(`[DEBUG] Windows: Trying ${resolver.name} to resolve ${hostname}...`);
                                const ip = await resolver.fn();
                                if (ip) {
                                    cachedDeviceIp = ip;
                                    console.log(`[DEBUG] Resolved ${hostname} to ${cachedDeviceIp} via ${resolver.name}`);
                                    resolved = true;
                                    break;
                                }
                            } catch (resolverErr) {
                                console.log(`[DEBUG] ${resolver.name} failed: ${resolverErr.message}`);
                            }
                        }

                        if (!resolved) {
                            throw new Error('All Windows resolution methods failed');
                        }
                    } else {
                            // macOS/Linux: Use system resolver to get IPv4
                            const { stdout } = await new Promise((resolve, reject) => {
                                const cmd = process.platform === 'darwin'
                                    ? `dscacheutil -q host -a name ${hostname} | grep ip_address | head -1 | awk '{print $2}'`
                                    : `getent ahostsv4 ${hostname} | head -1 | awk '{print $1}'`;

                                require('child_process').exec(cmd, (err, stdout, stderr) => {
                                    if (err) reject(err);
                                    else resolve({ stdout });
                                });
                            });

                            const ip = stdout.trim();
                            if (ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
                                cachedDeviceIp = ip;
                                console.log(`[DEBUG] Resolved ${hostname} to ${cachedDeviceIp} (IPv4)`);
                            } else {
                                throw new Error('No IPv4 address found');
                            }
                        }
                } catch (err) {
                    // Don't cache hostname - leave cachedDeviceIp as null
                    console.log(`[DEBUG] DNS resolution failed: ${err.message}`);
                    console.log(`[DEBUG] Could not resolve ${hostname} to IPv4 address`);
                }
            }
        }

        // Simple HTTP validation only (SSH keys may not be set up yet)
        const validateUrl = cachedDeviceIp ? `http://${cachedDeviceIp}/` : baseUrl;
        console.log(`[DEBUG] Validating via HTTP: ${validateUrl}`);

        try {
            // If we don't have an IP yet, try to extract it from the HTTP connection
            if (!cachedDeviceIp && hostname.endsWith('.local')) {
                console.log(`[DEBUG] Attempting to get IP from HTTP connection...`);

                // Use Node's http module directly to access socket info
                const http = require('http');
                const connectedIp = await new Promise((resolve, reject) => {
                    const req = http.get(validateUrl, { timeout: 10000 }, (res) => {
                        const socketIp = res.socket.remoteAddress;
                        console.log(`[DEBUG] HTTP connected to IP: ${socketIp}`);
                        resolve(socketIp);
                        res.resume(); // Consume response
                    });
                    req.on('error', reject);
                    req.on('timeout', () => reject(new Error('HTTP connection timeout')));
                });

                if (connectedIp) {
                    // Clean up IPv6 formatting if needed (remove ::ffff: prefix)
                    let cleanIp = connectedIp.replace(/^::ffff:/, '');
                    cachedDeviceIp = cleanIp;
                    console.log(`[DEBUG] Cached IP from HTTP connection: ${cachedDeviceIp}`);
                }
            } else {
                // Just validate normally
                const response = await httpClient.get(validateUrl, { timeout: 10000 });
                console.log(`[DEBUG] HTTP validation successful`);
            }

            return true;
        } catch (err) {
            console.log(`[DEBUG] HTTP validation failed: ${err.message}`);
            return false;
        }
    } catch (err) {
        console.error('Device validation error:', err.message);
        return false;
    }
}

async function discoverIpViaSsh(hostname) {
    try {
        const { exec } = require('child_process');
        const { promisify } = require('util');
        const execAsync = promisify(exec);

        // Use SSH with verbose output to see the resolved IP
        // Try to connect and immediately exit, capture the verbose output
        const sshCmd = `ssh -v -o ConnectTimeout=5 -o StrictHostKeyChecking=no -o BatchMode=yes ableton@${hostname} exit 2>&1`;
        const { stdout, stderr } = await execAsync(sshCmd, { timeout: 10000 });

        // SSH writes debug info to stderr, look for "Connecting to" or "Connected to"
        const output = stdout + stderr;

        // Parse IP from output like "Connecting to move.local [192.168.1.100]"
        const ipMatch = output.match(/Connecting to [^\[]+\[(\d+\.\d+\.\d+\.\d+)\]/);
        if (ipMatch && ipMatch[1]) {
            return ipMatch[1];
        }

        // Alternative: run a command on the device to get its IP
        const ipCmd = `ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no -o BatchMode=yes ableton@${hostname} "hostname -I | awk '{print \\$1}'"`;
        const { stdout: ipOutput } = await execAsync(ipCmd, { timeout: 10000 });
        const ip = ipOutput.trim();

        if (ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
            return ip;
        }

        return null;
    } catch (err) {
        console.log('[DEBUG] SSH IP discovery error:', err.message);
        return null;
    }
}

function getSavedCookie() {
    return savedCookie;
}

async function clearSavedCookie() {
    savedCookie = null;
    try {
        if (fs.existsSync(cookieStore)) {
            await rm(cookieStore);
        }
    } catch (err) {
        console.error('Failed to delete cookie file:', err);
    }
    console.log('[DEBUG] Saved cookie cleared');
}

async function requestChallenge(baseUrl) {
    try {
        const response = await httpClient.post(`${baseUrl}/api/v1/challenge`, {});

        if (response.status !== 200) {
            throw new Error(`Challenge request failed: ${response.status}`);
        }

        return true;
    } catch (err) {
        throw new Error(`Failed to request challenge: ${err.message}`);
    }
}

async function submitAuthCode(baseUrl, code) {
    try {
        console.log('[DEBUG] Submitting auth code:', code);
        console.log('[DEBUG] Request URL:', `${baseUrl}/api/v1/challenge-response`);

        const response = await httpClient.post(`${baseUrl}/api/v1/challenge-response`, {
            secret: code
        });

        console.log('[DEBUG] Response status:', response.status);
        console.log('[DEBUG] Response data:', response.data);

        if (response.status !== 200) {
            throw new Error(`Auth failed: ${response.status} - ${JSON.stringify(response.data)}`);
        }

        // Extract Set-Cookie header
        const setCookie = response.headers['set-cookie'];
        if (setCookie && setCookie.length > 0) {
            savedCookie = setCookie[0].split(';')[0];
            await writeFile(cookieStore, savedCookie);
            return savedCookie;
        }

        throw new Error('No cookie returned from auth');
    } catch (err) {
        throw new Error(`Failed to submit auth code: ${err.message}`);
    }
}

// Check if a private key file is encrypted with a passphrase
function isKeyEncrypted(privateKeyPath) {
    try {
        if (!fs.existsSync(privateKeyPath)) return false;
        const content = fs.readFileSync(privateKeyPath, 'utf8');
        // Old-style PEM encryption (DEK-Info/Proc-Type: ENCRYPTED)
        if (content.includes('ENCRYPTED')) return true;
        // New OpenSSH format: header is "-----BEGIN OPENSSH PRIVATE KEY-----"
        // Decode the base64 body and check for non-"none" cipher/kdf
        // Unencrypted keys use cipher="none" kdf="none"
        // Encrypted keys use cipher="aes256-ctr" kdf="bcrypt" (or similar)
        if (content.includes('BEGIN OPENSSH PRIVATE KEY')) {
            const b64 = content.replace(/-----[A-Z ]+-----/g, '').replace(/\s/g, '');
            try {
                const buf = Buffer.from(b64, 'base64');
                const str = buf.toString('utf8', 0, Math.min(buf.length, 200));
                if (str.includes('bcrypt') || str.includes('aes256')) return true;
            } catch {}
        }
        return false;
    } catch (err) {
        console.log(`[DEBUG] Could not read key ${privateKeyPath}: ${err.message}`);
        return false;
    }
}

// Get the usable (non-encrypted) private key path, or null if none available
function getUsablePrivateKeyPath() {
    const sshDir = path.join(os.homedir(), '.ssh');
    const candidates = [
        { name: 'move_key', path: path.join(sshDir, 'move_key'), regenerateOnEncrypted: true },
        { name: 'id_ed25519', path: path.join(sshDir, 'id_ed25519'), regenerateOnEncrypted: false },
        { name: 'id_rsa', path: path.join(sshDir, 'id_rsa'), regenerateOnEncrypted: false },
    ];

    for (const key of candidates) {
        if (fs.existsSync(key.path)) {
            if (isKeyEncrypted(key.path)) {
                console.log(`[DEBUG] ${key.name} is passphrase-protected, skipping`);
                if (key.regenerateOnEncrypted) return null;
                continue;
            }
            return key.path;
        }
    }

    return null;
}

function findExistingSshKey() {
    const sshDir = path.join(os.homedir(), '.ssh');

    // Check keys in preference order: move_key > id_ed25519 > id_rsa
    // Skip keys whose private key is passphrase-protected
    const candidates = [
        { name: 'move_key', pubPath: path.join(sshDir, 'move_key.pub'), privPath: path.join(sshDir, 'move_key'), deleteOnEncrypted: true },
        { name: 'id_ed25519', pubPath: path.join(sshDir, 'id_ed25519.pub'), privPath: path.join(sshDir, 'id_ed25519'), deleteOnEncrypted: false },
        { name: 'id_rsa', pubPath: path.join(sshDir, 'id_rsa.pub'), privPath: path.join(sshDir, 'id_rsa'), deleteOnEncrypted: false },
    ];

    for (const key of candidates) {
        if (fs.existsSync(key.pubPath)) {
            if (isKeyEncrypted(key.privPath)) {
                console.log(`[DEBUG] Found ${key.name}.pub but private key is encrypted, skipping`);
                if (key.deleteOnEncrypted) {
                    try { fs.unlinkSync(key.privPath); } catch (e) {}
                    try { fs.unlinkSync(key.pubPath); } catch (e) {}
                    return null;
                }
                continue;
            }
            console.log(`[DEBUG] Found ${key.name}.pub`);
            return key.pubPath;
        }
    }

    return null;
}

async function generateNewSshKey() {
    try {
        const sshDir = path.join(os.homedir(), '.ssh');
        const keyPath = path.join(sshDir, 'move_key');

        // Ensure .ssh directory exists
        await mkdir(sshDir, { recursive: true });

        console.log('[DEBUG] Checking for ssh-keygen...');

        // Try to use native ssh-keygen (available on Windows 10+, macOS, Linux)
        const { exec } = require('child_process');
        const { promisify } = require('util');
        const execAsync = promisify(exec);

        try {
            // Test if ssh-keygen is available
            await execAsync('ssh-keygen -V', { timeout: 2000 }).catch(() => {
                // -V might not be supported, try version instead
                return execAsync('ssh-keygen', { timeout: 2000 });
            });

            console.log('[DEBUG] Using native ssh-keygen to generate key');

            // Generate Ed25519 key using ssh-keygen
            const keygenCmd = `ssh-keygen -t ed25519 -f "${keyPath}" -N "" -C "schwung-installer"`;
            await execAsync(keygenCmd);

            console.log('[DEBUG] Key pair generated successfully using ssh-keygen');
            return `${keyPath}.pub`;
        } catch (sshKeygenError) {
            console.log('[DEBUG] ssh-keygen not available, falling back to sshpk library');

            // Use sshpk library to generate OpenSSH-format keys
            // This format works with both ssh2 library and native SSH
            const sshpk = require('sshpk');

            // Generate Ed25519 key using Node.js crypto
            const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');

            // Export as PEM for sshpk to parse
            const privateKeyPem = privateKey.export({
                type: 'pkcs8',
                format: 'pem'
            });

            const publicKeyPem = publicKey.export({
                type: 'spki',
                format: 'pem'
            });

            // Parse with sshpk and convert to OpenSSH format
            const sshpkPrivateKey = sshpk.parsePrivateKey(privateKeyPem, 'pem');
            const sshpkPublicKey = sshpk.parseKey(publicKeyPem, 'pem');

            // Export in OpenSSH format (which ssh2 can read)
            const privateKeyOpenSSH = sshpkPrivateKey.toString('openssh');
            const publicKeySSH = sshpkPublicKey.toString('ssh') + ' schwung-installer\n';

            await writeFile(keyPath, privateKeyOpenSSH, { mode: 0o600 });
            await writeFile(`${keyPath}.pub`, publicKeySSH, { mode: 0o644 });

            console.log('[DEBUG] Key pair generated successfully using sshpk (OpenSSH format)');
            console.log('[DEBUG] Private key length:', privateKeyOpenSSH.length);
            return `${keyPath}.pub`;
        }
    } catch (err) {
        console.error('[DEBUG] Key generation error:', err);
        throw new Error(`Failed to generate SSH key: ${err.message}`);
    }
}

async function readPublicKey(keyPath) {
    try {
        return await readFile(keyPath, 'utf-8');
    } catch (err) {
        throw new Error(`Failed to read public key: ${err.message}`);
    }
}

async function submitSshKeyWithAuth(baseUrl, pubkey) {
    try {
        if (!savedCookie) {
            throw new Error('No auth cookie available');
        }

        // Use cached IP if available, otherwise fall back to baseUrl
        const targetUrl = cachedDeviceIp ? `http://${cachedDeviceIp}` : baseUrl;
        console.log('[DEBUG] Submitting SSH key to:', targetUrl);
        console.log('[DEBUG] Cookie:', savedCookie);

        // Remove comment from SSH key (everything after the last space)
        const keyParts = pubkey.trim().split(' ');
        const keyWithoutComment = keyParts.slice(0, 2).join(' '); // Keep only "ssh-rsa AAAA..."

        console.log('[DEBUG] Pubkey length:', keyWithoutComment.length);
        console.log('[DEBUG] Pubkey content:', keyWithoutComment);

        // Send SSH key as raw POST body (not form field)
        const response = await httpClient.post(`${targetUrl}/api/v1/ssh`, keyWithoutComment, {
            headers: {
                'Cookie': savedCookie,
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });

        console.log('[DEBUG] SSH Response status:', response.status);
        console.log('[DEBUG] SSH Response data:', response.data);

        if (response.status !== 200) {
            throw new Error(`SSH key submission failed: ${response.status} - ${JSON.stringify(response.data)}`);
        }

        // Fix /data/authorized_keys permissions via root SSH so ableton can use it
        // (Move creates the file as 600 root:root, but sshd needs it readable for ableton)
        const hostIp = cachedDeviceIp || new URL(baseUrl).hostname;
        const keyPath = getUsablePrivateKeyPath();
        if (keyPath) {
            try {
                const { exec } = require('child_process');
                const execAsync = promisify(exec);
                await execAsync(`ssh -i "${keyPath}" -o StrictHostKeyChecking=no -o ConnectTimeout=5 -o BatchMode=yes root@${hostIp} "chmod 644 /data/authorized_keys"`, { timeout: 10000 });
                console.log('[DEBUG] Fixed /data/authorized_keys permissions');
            } catch (fixErr) {
                console.log('[DEBUG] Could not fix authorized_keys permissions (non-fatal):', fixErr.message);
            }
        }

        return true;
    } catch (err) {
        throw new Error(`Failed to submit SSH key: ${err.message}`);
    }
}

async function clearStaleHostKeys(hostname) {
    const hostIp = cachedDeviceIp || hostname;
    const targets = [hostIp, hostname, 'move.local', 'movedevice'];
    const { exec } = require('child_process');
    const execAsync = promisify(exec);
    for (const target of targets) {
        try {
            await execAsync(`ssh-keygen -R "${target}" 2>/dev/null`, { timeout: 5000 });
        } catch {}
    }
    console.log('[DEBUG] Cleared stale host keys for:', targets.join(', '));
}

async function testSsh(hostname) {
    try {
        // Use move_key if it exists, otherwise id_rsa (skip encrypted keys)
        const keyPath = getUsablePrivateKeyPath();

        console.log('[DEBUG] testSsh: Usable key path:', keyPath);

        if (!keyPath) {
            console.log('[DEBUG] No usable SSH key found for testing');
            return false;
        }

        // Use cached IP from HTTP connection first, then try DNS
        let hostIp = cachedDeviceIp || hostname;
        if (!cachedDeviceIp) {
            try {
                const addresses = await dnsResolve4(hostname);
                if (addresses && addresses.length > 0) {
                    hostIp = addresses[0];
                    console.log(`[DEBUG] Resolved ${hostname} to IPv4: ${hostIp}`);
                }
            } catch (err) {
                console.log(`[DEBUG] DNS resolution failed: ${err.message}`);
                // Fall back to hostname as-is
                hostIp = hostname;
            }
        } else {
            console.log(`[DEBUG] Using cached IP: ${hostIp}`);
        }

        // Try native SSH first (Windows 10+, macOS, Linux)
        const { exec } = require('child_process');
        const { promisify } = require('util');
        const execAsync = promisify(exec);

        try {
            console.log('[DEBUG] Trying native SSH...');

            // Only test ableton — that's the user install.sh needs
            try {
                console.log(`[DEBUG] Testing SSH as ableton@${hostIp} using native ssh`);

                const sshCmd = `ssh -i "${keyPath}" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5 -o BatchMode=yes ableton@${hostIp} "echo test"`;
                const { stdout } = await execAsync(sshCmd, { timeout: 8000 });

                if (stdout.trim() === 'test') {
                    console.log(`[DEBUG] Native SSH works as ableton@${hostIp}`);

                    // Fix authorized_keys permissions (non-fatal)
                    try {
                        const chmodCmd = `ssh -i "${keyPath}" -o StrictHostKeyChecking=no -o BatchMode=yes ableton@${hostIp} "chmod 600 ~/.ssh/authorized_keys 2>/dev/null; chmod 700 ~/.ssh 2>/dev/null; true"`;
                        await execAsync(chmodCmd, { timeout: 5000 });
                    } catch (chmodErr) {
                        console.log('[DEBUG] chmod authorized_keys failed (non-fatal):', chmodErr.message);
                    }

                    return true;
                }
            } catch (userErr) {
                const errOutput = (userErr.stderr || userErr.message || '').toString();
                console.log(`[DEBUG] Native SSH failed for ableton:`, errOutput);

                // Detect host key change and auto-recover
                if (/REMOTE HOST IDENTIFICATION HAS CHANGED|host key verification failed/i.test(errOutput)) {
                    console.log('[DEBUG] Host key changed, clearing stale keys and retrying...');
                    await clearStaleHostKeys(hostname);

                    // Retry once after clearing
                    try {
                        const retryCmd = `ssh -i "${keyPath}" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5 -o BatchMode=yes ableton@${hostIp} "echo test"`;
                        const { stdout: retryOut } = await execAsync(retryCmd, { timeout: 8000 });
                        if (retryOut.trim() === 'test') {
                            console.log('[DEBUG] SSH works after clearing stale host keys');
                            return true;
                        }
                    } catch (retryErr) {
                        console.log('[DEBUG] SSH retry after host key clear failed:', retryErr.message);
                    }
                }

                // Detect permission denied and try root fallback
                if (/permission denied/i.test(errOutput)) {
                    console.log('[DEBUG] Permission denied for ableton, trying root fallback...');
                    try {
                        const rootCmd = `ssh -i "${keyPath}" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5 -o BatchMode=yes root@${hostIp} "chmod 644 /data/authorized_keys && echo fixed"`;
                        const { stdout: rootOut } = await execAsync(rootCmd, { timeout: 8000 });
                        if (rootOut.trim() === 'fixed') {
                            console.log('[DEBUG] Fixed /data/authorized_keys permissions via root, retrying ableton...');
                            const retryCmd = `ssh -i "${keyPath}" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5 -o BatchMode=yes ableton@${hostIp} "echo test"`;
                            const { stdout: retryOut } = await execAsync(retryCmd, { timeout: 8000 });
                            if (retryOut.trim() === 'test') {
                                console.log('[DEBUG] SSH works after permissions fix');
                                return true;
                            }
                        }
                    } catch (rootErr) {
                        console.log('[DEBUG] Root fallback failed:', rootErr.message);
                    }
                }
            }

            console.log('[DEBUG] Native SSH failed, trying ssh2 library...');
        } catch (nativeSshErr) {
            console.log('[DEBUG] Native SSH not available, using ssh2 library');
        }

        // Fallback to ssh2 library
        console.log('[DEBUG] testSsh: Reading private key for ssh2...');
        const privateKey = fs.readFileSync(keyPath);
        console.log('[DEBUG] testSsh: Private key length:', privateKey.length);

        const users = ['ableton'];

        for (const username of users) {
            console.log(`[DEBUG] Testing SSH as ${username}@${hostIp} using ssh2...`);

            const connected = await new Promise((resolve) => {
                const conn = new Client();
                let resolved = false;

                const timeout = setTimeout(() => {
                    console.log(`[DEBUG] Manual timeout fired for ${username}`);
                    if (!resolved) {
                        resolved = true;
                        conn.end();
                        resolve(false);
                    }
                }, 8000);

                conn.on('ready', () => {
                    console.log(`[DEBUG] SSH 'ready' event for ${username}`);
                    clearTimeout(timeout);
                    if (resolved) return;
                    resolved = true;

                    // If connected as ableton, fix authorized_keys permissions
                    if (username === 'ableton') {
                        console.log('[DEBUG] Connected as ableton, fixing authorized_keys permissions');
                        conn.exec('chmod 600 ~/.ssh/authorized_keys && chmod 700 ~/.ssh', (err) => {
                            conn.end();
                            resolve(true);
                        });
                    } else {
                        conn.end();
                        resolve(true);
                    }
                });

                conn.on('error', (err) => {
                    console.log(`[DEBUG] SSH 'error' event for ${username}:`, err.message);
                    clearTimeout(timeout);
                    if (resolved) return;
                    resolved = true;
                    resolve(false);
                });

                conn.on('close', (hadError) => {
                    console.log(`[DEBUG] SSH 'close' event for ${username}, hadError:`, hadError);
                    clearTimeout(timeout);
                    if (resolved) return;
                    resolved = true;
                    resolve(false);
                });

                conn.on('timeout', () => {
                    console.log(`[DEBUG] SSH 'timeout' event for ${username}`);
                    clearTimeout(timeout);
                    if (resolved) return;
                    resolved = true;
                    conn.end();
                    resolve(false);
                });

                try {
                    console.log(`[DEBUG] Calling conn.connect() for ${username}`);
                    conn.connect({
                        host: hostIp,
                        port: 22,
                        username: username,
                        privateKey: privateKey,
                        readyTimeout: 8000,
                        family: 4  // Force IPv4
                    });
                    console.log(`[DEBUG] conn.connect() called successfully for ${username}`);
                } catch (err) {
                    console.log(`[DEBUG] Exception in conn.connect() for ${username}:`, err.message);
                    clearTimeout(timeout);
                    if (resolved) return;
                    resolved = true;
                    resolve(false);
                }
            });

            if (connected) {
                console.log(`[DEBUG] SSH works as ${username}@${hostIp}`);
                return true;
            }
        }

        console.log('[DEBUG] SSH failed for all users');
        return false;
    } catch (err) {
        console.error('[DEBUG] testSsh error:', err.message);
        console.error('[DEBUG] testSsh stack:', err.stack);
        return false;
    }
}

async function setupSshConfig(hostname = 'move.local') {
    const sshDir = path.join(os.homedir(), '.ssh');
    const configPath = path.join(sshDir, 'config');

    // Strip brackets from IPv6 if present
    const deviceIp = cachedDeviceIp ? cachedDeviceIp.replace(/^\[|\]$/g, '') : null;

    // Use whichever SSH key actually exists and is usable (skip encrypted keys)
    const usableKeyPath = getUsablePrivateKeyPath();
    let identityFile = '~/.ssh/id_ed25519';
    if (usableKeyPath) {
        identityFile = '~/' + path.relative(os.homedir(), usableKeyPath).replace(/\\/g, '/');
    } else if (fs.existsSync(path.join(sshDir, 'id_ed25519'))) {
        identityFile = '~/.ssh/id_ed25519';
    }

    // Escape hostname for use in regex
    const hostnameEscaped = hostname.replace(/\./g, '\\.');

    let configEntry = `
Host ${hostname}
    HostName ${hostname}
    User ableton
    IdentityFile ${identityFile}
    StrictHostKeyChecking no
    UserKnownHostsFile /dev/null
`;

    // Add a simple alias "movedevice" that points to the actual IP
    // This avoids IPv6 bracket issues in install.sh
    if (deviceIp) {
        configEntry += `
Host movedevice
    HostName ${deviceIp}
    User ableton
    IdentityFile ${identityFile}
    StrictHostKeyChecking no
    UserKnownHostsFile /dev/null
`;
    }

    try {
        let existingConfig = '';
        if (fs.existsSync(configPath)) {
            existingConfig = await readFile(configPath, 'utf-8');
            existingConfig = existingConfig.replace(/\r\n/g, '\n');
        }

        // Remove old entries to avoid duplicates
        const hostnameRegex = new RegExp(`Host ${hostnameEscaped}\n(?:.*\n)*?(?=Host |$)`, 'm');
        existingConfig = existingConfig.replace(hostnameRegex, '');
        existingConfig = existingConfig.replace(/Host movedevice\n(?:.*\n)*?(?=Host |$)/m, '');

        await writeFile(configPath, existingConfig + configEntry);
        console.log(`[DEBUG] SSH config updated for ${hostname} and movedevice ->`, deviceIp);
    } catch (err) {
        throw new Error(`Failed to setup SSH config: ${err.message}`);
    }
}

async function getModuleCatalog() {
    try {
        const response = await httpClient.get(
            'https://raw.githubusercontent.com/charlesvestal/schwung/main/module-catalog.json'
        );

        if (response.status !== 200) {
            throw new Error(`Failed to fetch catalog: ${response.status}`);
        }

        let catalog = response.data;

        // If it's a string, parse it
        if (typeof catalog === 'string') {
            catalog = JSON.parse(catalog);
        }

        // Handle v2 catalog format
        const moduleList = catalog.modules || catalog;

        // For each module, fetch module.json from repo for version + assets info
        const modules = await Promise.all(moduleList.map(async (module) => {
            const downloadUrl = `https://github.com/${module.github_repo}/releases/latest/download/${module.asset_name}`;

            let version = null;
            let assets = null;
            let hasModuleJson = false;

            try {
                console.log(`[DEBUG] Fetching module.json for: ${module.id}`);
                const branch = module.default_branch || 'main';
                const mjResponse = await httpClient.get(
                    `https://raw.githubusercontent.com/${module.github_repo}/${branch}/src/module.json`
                );
                if (mjResponse.status === 200) {
                    const mj = typeof mjResponse.data === 'string' ? JSON.parse(mjResponse.data) : mjResponse.data;
                    version = mj.version || null;
                    assets = mj.assets || null;
                    hasModuleJson = true;
                    console.log(`[DEBUG] Found version ${version} for ${module.id}`);
                } else {
                    console.log(`[DEBUG] Skipping module ${module.id}: module.json returned HTTP ${mjResponse.status}`);
                }
            } catch (err) {
                console.log(`[DEBUG] Skipping module ${module.id}: module.json unavailable (${err.message})`);
            }

            if (!hasModuleJson) {
                return null;
            }

            return {
                ...module,
                version,
                assets,
                download_url: downloadUrl
            };
        }));

        return modules.filter(Boolean);
    } catch (err) {
        throw new Error(`Failed to get module catalog: ${err.message}`);
    }
}

async function getLatestRelease() {
    try {
        // Fetch all releases and find the latest binary release (v* tag, not installer-v*)
        const response = await httpClient.get('https://api.github.com/repos/charlesvestal/schwung/releases', {
            headers: {
                'User-Agent': 'MoveEverything-Installer'
            }
        });

        console.log('[DEBUG] GitHub API response status:', response.status);

        if (response.status === 200 && Array.isArray(response.data)) {
            // Find the highest-versioned binary release (API order is unreliable after tag rewrites)
            const binaryReleases = response.data.filter(r => /^v\d/.test(r.tag_name));
            binaryReleases.sort((a, b) => {
                const va = a.tag_name.replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
                const vb = b.tag_name.replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
                for (let i = 0; i < Math.max(va.length, vb.length); i++) {
                    if ((vb[i] || 0) !== (va[i] || 0)) return (vb[i] || 0) - (va[i] || 0);
                }
                return 0;
            });
            const binaryRelease = binaryReleases[0];
            if (binaryRelease) {
                const tagName = binaryRelease.tag_name;
                const version = tagName.startsWith('v') ? tagName.substring(1) : tagName;
                const assetName = 'schwung.tar.gz';
                const downloadUrl = `https://github.com/charlesvestal/schwung/releases/download/${tagName}/${assetName}`;

                console.log('[DEBUG] Found binary release:', tagName, 'version:', version);

                return {
                    version: version,
                    asset_name: assetName,
                    download_url: downloadUrl
                };
            }
        }

        throw new Error('No binary release found');
    } catch (err) {
        console.error('[DEBUG] Failed to get version from API:', err.message);
        // Fallback: try /releases/latest which may or may not be correct
        const assetName = 'schwung.tar.gz';
        const downloadUrl = `https://github.com/charlesvestal/schwung/releases/latest/download/${assetName}`;
        return {
            version: 'latest',
            asset_name: assetName,
            download_url: downloadUrl
        };
    }
}

async function getLatestInstallerRelease() {
    try {
        const response = await httpClient.get(
            'https://api.github.com/repos/charlesvestal/schwung-installer/releases/latest',
            { headers: { 'User-Agent': 'MoveEverything-Installer' } }
        );
        if (response.status === 200 && response.data.tag_name) {
            return {
                version: response.data.tag_name.replace(/^v/, ''),
                url: response.data.html_url
            };
        }
    } catch (err) {
        console.error('[DEBUG] Installer version check failed:', err.message);
    }
    return null;
}

async function checkInstallerUpdate(currentVersion) {
    const release = await getLatestInstallerRelease();
    if (!release) return null;
    return {
        updateAvailable: isNewerVersion(release.version, currentVersion),
        latestVersion: release.version,
        url: release.url
    };
}

async function downloadRelease(url, destPath) {
    try {
        // If destPath is just a filename or starts with /tmp/, use system temp dir
        let actualDestPath = destPath;
        if (!path.isAbsolute(destPath) || destPath.startsWith('/tmp/')) {
            const filename = path.basename(destPath);
            actualDestPath = path.join(os.tmpdir(), filename);
            console.log(`[DEBUG] Using temp path: ${actualDestPath}`);
        }
        const maxAttempts = 4;
        let lastError = null;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                const response = await httpClient.get(url, {
                    responseType: 'stream'
                });

                if (response.status < 200 || response.status >= 300) {
                    const statusText = response.statusText ? ` ${response.statusText}` : '';
                    const statusError = new Error(`HTTP ${response.status}${statusText} while downloading ${url}`);
                    const isTransientStatus = response.status === 429 || (response.status >= 500 && response.status <= 599);

                    if (response.data && typeof response.data.destroy === 'function') {
                        response.data.destroy();
                    }

                    if (isTransientStatus && attempt < maxAttempts) {
                        const retryDelayMs = 1000 * attempt;
                        console.log(`[DEBUG] Transient download error (attempt ${attempt}/${maxAttempts}): ${statusError.message}. Retrying in ${retryDelayMs}ms...`);
                        await fs.promises.rm(actualDestPath, { force: true }).catch(() => {});
                        await new Promise(resolve => setTimeout(resolve, retryDelayMs));
                        continue;
                    }

                    throw statusError;
                }

                const writer = fs.createWriteStream(actualDestPath);
                response.data.pipe(writer);

                await new Promise((resolve, reject) => {
                    response.data.on('error', reject);
                    writer.on('finish', resolve);
                    writer.on('error', reject);
                });

                const expectsTarGz = /\.tar\.gz($|\?)/i.test(url) || /\.tar\.gz$/i.test(actualDestPath);
                if (expectsTarGz) {
                    const fileHandle = await fs.promises.open(actualDestPath, 'r');
                    try {
                        const magic = Buffer.alloc(2);
                        const { bytesRead } = await fileHandle.read(magic, 0, 2, 0);
                        const magicHex = magic.slice(0, bytesRead).toString('hex');
                        if (magicHex !== '1f8b') {
                            const contentType = response.headers && response.headers['content-type'] ? response.headers['content-type'] : 'unknown';
                            throw new Error(`Downloaded file is not a gzip archive (magic=${magicHex || 'empty'}, content-type=${contentType})`);
                        }
                    } finally {
                        await fileHandle.close();
                    }
                }

                return actualDestPath;
            } catch (err) {
                lastError = err;
                const msg = err && err.message ? err.message : String(err);
                const isTransientNetworkError = /ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|EPIPE|ENETUNREACH/i.test(msg);

                if (isTransientNetworkError && attempt < maxAttempts) {
                    const retryDelayMs = 1000 * attempt;
                    console.log(`[DEBUG] Network download error (attempt ${attempt}/${maxAttempts}): ${msg}. Retrying in ${retryDelayMs}ms...`);
                    await fs.promises.rm(actualDestPath, { force: true }).catch(() => {});
                    await new Promise(resolve => setTimeout(resolve, retryDelayMs));
                    continue;
                }

                throw err;
            }
        }

        throw lastError || new Error('Download failed after retries');
    } catch (err) {
        throw new Error(`Failed to download release: ${err.message}`);
    }
}

async function sshExec(hostname, command, { username = 'ableton' } = {}) {
    // Use cached IP from session (already resolved in validateDevice)
    // Prefer cached IP, but allow fallback to hostname for SSH (native ssh can resolve .local)
    const hostIp = cachedDeviceIp || hostname;

    // Use move_key if it exists, otherwise id_rsa (skip encrypted keys)
    const keyPath = getUsablePrivateKeyPath();
    if (!keyPath) {
        throw new Error('No usable SSH key found (keys may be passphrase-protected)');
    }

    // Try native SSH first
    try {
        const { exec } = require('child_process');
        const { promisify } = require('util');
        const execAsync = promisify(exec);

        const sshCmd = `ssh -i "${keyPath}" -o StrictHostKeyChecking=no -o BatchMode=yes ${username}@${hostIp} "${command.replace(/"/g, '\\"')}"`;
        const { stdout } = await execAsync(sshCmd, { timeout: 30000 });
        return stdout;
    } catch (nativeErr) {
        // Fallback to ssh2 library
        return new Promise((resolve, reject) => {
            const conn = new Client();

            conn.on('ready', () => {
                conn.exec(command, (err, stream) => {
                    if (err) {
                        conn.end();
                        return reject(err);
                    }

                    let stdout = '';
                    let stderr = '';

                    stream.on('data', (data) => {
                        stdout += data.toString();
                    });

                    stream.stderr.on('data', (data) => {
                        stderr += data.toString();
                    });

                    stream.on('close', (code) => {
                        conn.end();
                        if (code === 0) {
                            resolve(stdout);
                        } else {
                            reject(new Error(`Command failed with code ${code}: ${stderr}`));
                        }
                    });
                });
            });

            conn.on('error', (err) => {
                reject(err);
            });

            conn.connect({
                host: hostIp,
                port: 22,
                username,
                privateKey: fs.readFileSync(keyPath),
                family: 4  // Force IPv4
            });
        });
    }
}

async function sshExecWithRetry(hostname, command, options = {}) {
    const { maxRetries = 3, delayMs = 2000, ...sshOptions } = options;
    let lastErr;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await sshExec(hostname, command, sshOptions);
        } catch (err) {
            lastErr = err;
            console.log(`[DEBUG] SSH attempt ${attempt}/${maxRetries} failed: ${err.message}`);
            if (attempt < maxRetries) {
                await new Promise(r => setTimeout(r, delayMs));
            }
        }
    }
    throw lastErr;
}

async function execWithRetry(command, options = {}) {
    const { maxRetries = 3, delayMs = 2000, ...execOptions } = options;
    const { exec } = require('child_process');
    const execAsync = promisify(exec);
    let lastErr;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await execAsync(command, execOptions);
        } catch (err) {
            lastErr = err;
            console.log(`[DEBUG] exec attempt ${attempt}/${maxRetries} failed: ${err.message}`);
            if (attempt < maxRetries) {
                await new Promise(r => setTimeout(r, delayMs));
            }
        }
    }
    throw lastErr;
}

// Helper to upload file via SFTP
async function sftpUpload(hostname, localPath, remotePath, { username = 'ableton' } = {}) {
    const hostIp = cachedDeviceIp || hostname;
    const keyPath = getUsablePrivateKeyPath();
    if (!keyPath) {
        throw new Error('No usable SSH key found (keys may be passphrase-protected)');
    }

    return new Promise((resolve, reject) => {
        const conn = new Client();

        conn.on('ready', () => {
            conn.sftp((err, sftp) => {
                if (err) {
                    conn.end();
                    return reject(err);
                }

                sftp.fastPut(localPath, remotePath, (err) => {
                    conn.end();
                    if (err) {
                        reject(err);
                    } else {
                        resolve();
                    }
                });
            });
        });

        conn.on('error', (err) => {
            reject(err);
        });

        conn.connect({
            host: hostIp,
            port: 22,
            username,
            privateKey: fs.readFileSync(keyPath),
            family: 4
        });
    });
}

// Helper to download file via SFTP
async function sftpDownload(hostname, remotePath, localPath, { username = 'ableton' } = {}) {
    const hostIp = cachedDeviceIp || hostname;
    const keyPath = getUsablePrivateKeyPath();
    if (!keyPath) {
        throw new Error('No usable SSH key found (keys may be passphrase-protected)');
    }

    return new Promise((resolve, reject) => {
        const conn = new Client();

        conn.on('ready', () => {
            conn.sftp((err, sftp) => {
                if (err) {
                    conn.end();
                    return reject(err);
                }

                sftp.fastGet(remotePath, localPath, (err) => {
                    conn.end();
                    if (err) {
                        reject(err);
                    } else {
                        resolve();
                    }
                });
            });
        });

        conn.on('error', (err) => {
            reject(err);
        });

        conn.connect({
            host: hostIp,
            port: 22,
            username,
            privateKey: fs.readFileSync(keyPath),
            family: 4
        });
    });
}

async function downloadRemoteFile(hostname, remotePath, localPath) {
    try {
        // Validate path is within schwung directory
        if (!remotePath.startsWith('/data/UserData/schwung/')) {
            throw new Error('Path must be within /data/UserData/schwung/');
        }
        const hostIp = cachedDeviceIp || hostname;
        await sftpDownload(hostIp, remotePath, localPath);
        return true;
    } catch (err) {
        console.error('[DEBUG] downloadRemoteFile error:', err.message);
        throw new Error(`Failed to download remote file: ${err.message}`);
    }
}

async function findGitBash() {
    const bashPaths = [
        'C:\\Program Files\\Git\\bin\\bash.exe',
        'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
        path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
        path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
        'bash',  // Last resort — could be WSL, but Git Bash paths above should catch most installs
    ];

    const { exec } = require('child_process');
    const { promisify } = require('util');
    const execAsync = promisify(exec);

    for (const bashPath of bashPaths) {
        try {
            await execAsync(`"${bashPath}" --version`, { timeout: 2000 });
            console.log('[DEBUG] Found Git Bash at:', bashPath);
            return bashPath;
        } catch (err) {
            // Try next path
        }
    }

    return null;
}

async function checkGitBashAvailable() {
    // Only required on Windows
    if (process.platform !== 'win32') {
        return { available: true };
    }

    const bashPath = await findGitBash();
    return {
        available: bashPath !== null,
        path: bashPath
    };
}

async function installMain(tarballPath, hostname, flags = []) {
    try {
        // Verify we have a valid IP address (IPv4 or IPv6)
        if (!cachedDeviceIp) {
            throw new Error(
                'Cannot install: Device IP address not available.\n' +
                'Please enter the device IP address manually.'
            );
        }

        console.log('[DEBUG] Installing using IP:', cachedDeviceIp);

        // On Windows, check for Git Bash
        if (process.platform === 'win32') {
            const bashPath = await findGitBash();
            if (!bashPath) {
                throw new Error(
                    'Git Bash is required for installation on Windows.\n\n' +
                    'Please install Git for Windows from:\n' +
                    'https://git-scm.com/download/win\n\n' +
                    'Then restart the installer.'
                );
            }
        }

        const hostIp = cachedDeviceIp;
        console.log('[DEBUG] Installing to:', hostIp);
        console.log('[DEBUG] Install flags:', flags);

        // Ensure SSH config alias exists before running install.sh
        // (install.sh uses "movedevice" as hostname, which must resolve via ~/.ssh/config)
        await setupSshConfig(hostname);

        const { exec } = require('child_process');
        const { promisify } = require('util');
        const execAsync = promisify(exec);

        // Clear stale host keys for this device (e.g. after a reformat)
        await clearStaleHostKeys(hostname);

        // Find bash - use /bin/bash directly on macOS/Linux, find Git Bash on Windows
        const bashPath = process.platform === 'win32' ? await findGitBash() : '/bin/bash';

        // Create temp directory for install script
        const tempDir = path.join(os.tmpdir(), `move-installer-${Date.now()}`);
        await mkdir(tempDir, { recursive: true });
        await mkdir(path.join(tempDir, 'scripts'), { recursive: true });

        try {
            // Download install.sh from GitHub (same source as the tarball)
            console.log('[DEBUG] Downloading install.sh from GitHub...');
            const installScriptUrl = 'https://raw.githubusercontent.com/charlesvestal/schwung/main/scripts/install.sh';
            const response = await httpClient.get(installScriptUrl);
            let installScriptContent = response.data;

            // Replace move.local with "movedevice" SSH config alias
            // This works for both IPv4 and IPv6 without bracket issues
            installScriptContent = installScriptContent.replace(/move\.local/g, 'movedevice');
            console.log('[DEBUG] Replaced move.local with movedevice (SSH config -> ', hostIp, ')');

            const tempInstallScript = path.join(tempDir, 'scripts', 'install.sh');
            await writeFile(tempInstallScript, installScriptContent, { mode: 0o755 });

            // Copy tarball to temp directory
            const tempTarball = path.join(tempDir, 'schwung.tar.gz');
            await copyFile(tarballPath, tempTarball);

            // Pre-flight: verify Git Bash SSH can connect to movedevice
            // (the Electron app uses ssh2 library, but install.sh uses native SSH via Git Bash)
            if (process.platform === 'win32') {
                console.log('[DEBUG] Pre-flight: testing Git Bash SSH to movedevice...');
                try {
                    await execWithRetry(`"${bashPath}" -c "ssh -o StrictHostKeyChecking=no -o BatchMode=yes -o ConnectTimeout=5 movedevice echo ok"`, { timeout: 15000 });
                    console.log('[DEBUG] Pre-flight: Git Bash SSH to movedevice OK');
                } catch (sshTestErr) {
                    const errMsg = (sshTestErr.stderr || sshTestErr.message || '').trim();
                    console.log('[DEBUG] Pre-flight: Git Bash SSH failed:', errMsg);
                    // Try with explicit key and IP as fallback diagnostic
                    const keyPath = getUsablePrivateKeyPath();
                    const keyFlag = keyPath ? `-i "${keyPath.replace(/\\/g, '/')}"` : '';
                    try {
                        await execWithRetry(`"${bashPath}" -c "ssh ${keyFlag} -o StrictHostKeyChecking=no -o BatchMode=yes -o ConnectTimeout=5 ableton@${hostIp} echo ok"`, { timeout: 15000 });
                        console.log('[DEBUG] Pre-flight: direct IP SSH works, SSH config alias may be broken - rebuilding...');
                        // SSH config alias is broken but direct connection works - rebuild config
                        await setupSshConfig(hostname);
                    } catch (directErr) {
                        throw new Error(
                            `SSH connection from Git Bash failed.\n\n` +
                            `The installer verified SSH works, but Git Bash's SSH cannot connect to the device.\n` +
                            `This can happen if Git Bash uses a different SSH configuration.\n\n` +
                            `Error: ${errMsg}\n\n` +
                            `Try: Open Git Bash and run: ssh ableton@${hostIp}`
                        );
                    }
                }
            }

            // Pre-install cleanup: remove stale temp files and root-owned tarball on device
            console.log('[DEBUG] Cleaning up stale files on device...');
            try {
                const cleanupCmds = [
                    'rm -f ~/schwung.tar.gz',  // Remove old tarball (may be root-owned)
                    'rm -rf /var/volatile/tmp/move-install-* /var/volatile/tmp/move-uninstall-*',  // Stale temp dirs
                    'rm -f /tmp/*.log /tmp/*.json /tmp/*.tar.gz'  // Logs, json, tarballs filling root partition
                ];
                for (const cleanCmd of cleanupCmds) {
                    // Try as ableton first, then as root for permission issues
                    try {
                        await execAsync(`"${bashPath}" -c "ssh movedevice '${cleanCmd}'"`, { timeout: 10000 });
                    } catch (e) {
                        try {
                            await execAsync(`"${bashPath}" -c "ssh -i ~/.ssh/move_key -o StrictHostKeyChecking=no root@movedevice '${cleanCmd}'"`, { timeout: 10000 });
                        } catch (e2) {
                            console.log('[DEBUG] Cleanup command failed (non-fatal):', cleanCmd);
                        }
                    }
                }
                console.log('[DEBUG] Device cleanup complete');
            } catch (cleanupErr) {
                console.log('[DEBUG] Device cleanup failed (non-fatal):', cleanupErr.message);
            }

            // Build install.sh arguments
            const installArgs = ['local', '--skip-confirmation', '--skip-modules', ...flags];

            // Convert Windows path to Unix path for Git Bash
            const unixTempDir = tempDir.replace(/\\/g, '/').replace(/^([A-Z]):/, (match, drive) => {
                return `/${drive.toLowerCase()}`;
            });

            // Run install.sh via Git Bash
            console.log('[DEBUG] Running install.sh via Git Bash...');
            console.log('[DEBUG] Script:', tempInstallScript);
            console.log('[DEBUG] Args:', installArgs.join(' '));

            // Redirect stdin from /dev/null so install.sh never blocks on interactive prompts
            const cmd = `"${bashPath}" -c "cd '${unixTempDir}/scripts' && ./install.sh ${installArgs.join(' ')} < /dev/null"`;
            console.log('[DEBUG] Command:', cmd);

            let stdout, stderr;
            try {
                const result = await execAsync(cmd, {
                    timeout: 300000,  // 5 minutes
                    maxBuffer: 10 * 1024 * 1024  // 10MB buffer
                });
                stdout = result.stdout;
                stderr = result.stderr;
            } catch (execError) {
                // Capture output even on failure
                stdout = execError.stdout || '';
                stderr = execError.stderr || '';
                console.log('[DEBUG] Install script failed!');
                console.log('[DEBUG] Exit code:', execError.code);
                console.log('[DEBUG] stdout:', stdout);
                console.log('[DEBUG] stderr:', stderr);

                // Check if installation itself succeeded but only the restart failed
                // Look for "Configuring features" (install complete) + restart failure markers
                const installSucceeded = stdout.includes('Configuring features');
                const restartFailed = stdout.includes('Failed to restart Move service') ||
                    (stdout.includes('Restarting Move') && stdout.includes('SSH command failed'));

                if (installSucceeded && restartFailed) {
                    console.log('[DEBUG] Install succeeded but restart failed - attempting backend restart...');
                    try {
                        // Try to restart via backend SSH (has ssh2 fallback, more reliable on Windows)
                        await sshExecWithRetry(hostIp, '/etc/init.d/move stop >/dev/null 2>&1 || true', { username: 'root' });
                        await new Promise(r => setTimeout(r, 3000));
                        await sshExecWithRetry(hostIp, '/etc/init.d/move start >/dev/null 2>&1 || true', { username: 'root' });
                        console.log('[DEBUG] Backend restart succeeded');
                    } catch (restartErr) {
                        console.log('[DEBUG] Backend restart also failed (device may need manual reboot):', restartErr.message);
                        // Still treat as success - installation is complete, user can reboot
                    }
                    // Don't throw - installation itself succeeded
                } else {
                    throw new Error(
                        `install.sh failed with exit code ${execError.code}\n\n` +
                        `Output:\n${stdout}\n\n` +
                        `Errors:\n${stderr}`
                    );
                }
            }

            console.log('[DEBUG] Install script output:', stdout);
            if (stderr) {
                console.log('[DEBUG] Install script stderr:', stderr);
            }

            console.log('[DEBUG] Installation complete!');

            // Fix permissions: install.sh runs as root, so ensure ableton owns everything
            await fixPermissions(hostname);

            return true;
        } finally {
            // Clean up temp directory
            try {
                await rm(tempDir, { recursive: true, force: true });
            } catch (err) {
                console.log('[DEBUG] Failed to clean up temp dir:', err.message);
            }
        }
    } catch (err) {
        console.error('[DEBUG] Installation error:', err.message);
        throw new Error(`Installation failed: ${err.message}`);
    }
}

async function fixPermissions(hostname) {
    try {
        const hostIp = cachedDeviceIp || hostname;
        console.log('[DEBUG] Fixing permissions: chown -R ableton:users /data/UserData/schwung');
        await sshExecWithRetry(hostIp, 'chown -R ableton:users /data/UserData/schwung', { username: 'root' });
        console.log('[DEBUG] Permissions fixed');
        return true;
    } catch (err) {
        console.log('[DEBUG] Permission fix failed (non-fatal):', err.message);
        return false;
    }
}

function getInstallSubdir(componentType) {
    switch (componentType) {
        case 'sound_generator': return 'sound_generators';
        case 'audio_fx': return 'audio_fx';
        case 'midi_fx': return 'midi_fx';
        case 'utility': return 'utilities';
        case 'overtake': return 'overtake';
        case 'tool': return 'tools';
        default: return 'other';
    }
}

async function installModulePackage(moduleId, tarballPath, componentType, hostname) {
    try {
        console.log(`[DEBUG] Installing module ${moduleId} (${componentType})`);
        const filename = path.basename(tarballPath);

        // Use cached IP instead of hostname for faster connection
        const hostIp = cachedDeviceIp || hostname;
        console.log(`[DEBUG] Using host: ${hostIp} (cached: ${!!cachedDeviceIp})`);

        // Ensure target directory is writable by ableton (may be root-owned from older installs)
        const categoryPath = getInstallSubdir(componentType);
        try {
            await sshExecWithRetry(hostIp, `chown -R ableton:users /data/UserData/schwung/modules/${categoryPath}`, { username: 'root' });
        } catch (chownErr) {
            console.log('[DEBUG] chown fix failed (non-fatal):', chownErr.message);
        }

        // Upload to Schwung directory using SFTP
        const remotePath = `/data/UserData/schwung/${filename}`;
        console.log(`[DEBUG] Uploading ${filename} to device via SFTP...`);
        await sftpUpload(hostIp, tarballPath, remotePath);
        console.log(`[DEBUG] Upload complete for ${moduleId}`);

        // Extract and install module
        console.log(`[DEBUG] Extracting ${moduleId} to modules/${categoryPath}/`);
        await sshExecWithRetry(hostIp, `cd /data/UserData/schwung && mkdir -p modules/${categoryPath} && tar -xzf ${filename} -C modules/${categoryPath}/ && rm ${filename}`);
        console.log(`[DEBUG] Module ${moduleId} installed successfully`);

        return true;
    } catch (err) {
        console.error(`[DEBUG] Module installation error for ${moduleId}:`, err.message);
        throw new Error(`Module installation failed: ${err.message}`);
    }
}

async function installModuleBatch(modules, hostname, progressCallback = null) {
    const hostIp = cachedDeviceIp || hostname;
    const results = { installed: [], failed: [] };

    if (progressCallback) progressCallback({ phase: 'download', current: 0, total: modules.length, message: 'Starting downloads...' });

    // Phase 1: Download all tarballs in parallel (no device involvement)
    const PARALLEL_DOWNLOADS = 6;
    const downloadResults = [];

    for (let i = 0; i < modules.length; i += PARALLEL_DOWNLOADS) {
        const batch = modules.slice(i, i + PARALLEL_DOWNLOADS);
        const batchResults = await Promise.allSettled(
            batch.map(async (module) => {
                const destPath = path.join(os.tmpdir(), module.asset_name);
                console.log(`[DEBUG] Downloading ${module.id}...`);
                await downloadRelease(module.download_url, destPath);
                return { module, localPath: destPath };
            })
        );

        for (const result of batchResults) {
            if (result.status === 'fulfilled') {
                downloadResults.push(result.value);
            } else {
                const failedModule = batch[batchResults.indexOf(result)];
                console.log(`[DEBUG] Download failed for ${failedModule.id}: ${result.reason.message}`);
                results.failed.push({ id: failedModule.id, name: failedModule.name, error: result.reason.message });
            }
        }

        if (progressCallback) {
            const done = Math.min(i + PARALLEL_DOWNLOADS, modules.length);
            progressCallback({ phase: 'download', current: done, total: modules.length, message: `Downloaded ${done} of ${modules.length} modules...` });
        }
    }

    if (downloadResults.length === 0) {
        throw new Error('All downloads failed');
    }

    // Phase 2: Upload all tarballs via SFTP (sequential — single device connection)
    if (progressCallback) progressCallback({ phase: 'upload', current: 0, total: downloadResults.length, message: 'Uploading to device...' });

    const uploaded = [];
    for (let i = 0; i < downloadResults.length; i++) {
        const { module, localPath } = downloadResults[i];
        const filename = path.basename(localPath);
        const remotePath = `/data/UserData/schwung/${filename}`;

        try {
            console.log(`[DEBUG] Uploading ${module.id} to device...`);
            await sftpUpload(hostIp, localPath, remotePath);
            uploaded.push({ module, filename });

            if (progressCallback) {
                progressCallback({ phase: 'upload', current: i + 1, total: downloadResults.length, message: `Uploaded ${module.name} (${i + 1}/${downloadResults.length})...` });
            }
        } catch (err) {
            console.log(`[DEBUG] Upload failed for ${module.id}: ${err.message}`);
            results.failed.push({ id: module.id, name: module.name, error: err.message });
        }
    }

    // Phase 3: Extract all tarballs in a single SSH command
    if (uploaded.length > 0) {
        if (progressCallback) progressCallback({ phase: 'install', current: 0, total: uploaded.length, message: 'Installing modules on device...' });

        // Build a single extract command for all uploaded tarballs
        const extractCmds = uploaded.map(({ module, filename }) => {
            const categoryPath = getInstallSubdir(module.component_type);
            return `mkdir -p modules/${categoryPath} && tar -xzf ${filename} -C modules/${categoryPath}/ && rm ${filename}`;
        });

        try {
            const fullCmd = `cd /data/UserData/schwung && ${extractCmds.join(' && ')}`;
            await sshExecWithRetry(hostIp, fullCmd);

            // Fix ownership in one shot
            await sshExecWithRetry(hostIp, 'chown -R ableton:users /data/UserData/schwung/modules', { username: 'root' });

            for (const { module } of uploaded) {
                console.log(`[DEBUG] Module ${module.id} installed successfully`);
                results.installed.push({ id: module.id, name: module.name });
            }
        } catch (err) {
            console.log(`[DEBUG] Batch extract failed: ${err.message}, falling back to individual extracts`);
            // Fallback: extract one at a time so partial success is possible
            for (const { module, filename } of uploaded) {
                try {
                    const categoryPath = getInstallSubdir(module.component_type);
                    await sshExecWithRetry(hostIp, `cd /data/UserData/schwung && mkdir -p modules/${categoryPath} && tar -xzf ${filename} -C modules/${categoryPath}/ && rm ${filename}`);
                    results.installed.push({ id: module.id, name: module.name });
                } catch (extractErr) {
                    results.failed.push({ id: module.id, name: module.name, error: extractErr.message });
                }
            }
            // Fix ownership regardless
            try {
                await sshExecWithRetry(hostIp, 'chown -R ableton:users /data/UserData/schwung/modules', { username: 'root' });
            } catch {}
        }

        if (progressCallback) progressCallback({ phase: 'install', current: uploaded.length, total: uploaded.length, message: 'Installation complete!' });
    }

    // Clean up local temp files
    for (const { localPath } of downloadResults) {
        try { fs.unlinkSync(localPath); } catch {}
    }

    return results;
}

async function cleanDeviceTmp(hostname) {
    try {
        const hostIp = cachedDeviceIp || hostname;
        const asRoot = { username: 'root' };
        console.log('[DEBUG] Cleaning /tmp on device to free root partition space...');

        // Get before size
        let beforeFree = '';
        try {
            beforeFree = await sshExecWithRetry(hostIp, "df / | tail -1 | awk '{print $4}'", asRoot);
        } catch (e) { /* ignore */ }

        // Remove log, json, and tarball files from /tmp (root partition)
        const cleanupCmds = [
            'rm -f /tmp/*.log /tmp/*.json /tmp/*.tar.gz',
            'rm -rf /tmp/move-install-* /tmp/move-uninstall-*',
            'rm -rf /var/volatile/tmp/move-install-* /var/volatile/tmp/move-uninstall-*',
            'rm -f ~/schwung.tar.gz'
        ];

        for (const cmd of cleanupCmds) {
            try {
                await sshExecWithRetry(hostIp, cmd, asRoot);
            } catch (e) {
                console.log('[DEBUG] Cleanup cmd failed (non-fatal):', cmd, e.message);
            }
        }

        // Get after size
        let afterFree = '';
        try {
            afterFree = await sshExecWithRetry(hostIp, "df / | tail -1 | awk '{print $4}'", asRoot);
        } catch (e) { /* ignore */ }

        const freedKB = parseInt(afterFree) - parseInt(beforeFree);
        const freedMB = freedKB > 0 ? (freedKB / 1024).toFixed(1) : '0';
        console.log(`[DEBUG] Freed ${freedMB}MB on root partition`);

        return { success: true, freedMB };
    } catch (err) {
        console.error('[DEBUG] Device /tmp cleanup error:', err.message);
        throw new Error(`Cleanup failed: ${err.message}`);
    }
}

async function listRemoteDir(hostname, remotePath) {
    try {
        const hostIp = cachedDeviceIp || hostname;
        // Ensure the directory exists
        await sshExecWithRetry(hostIp, `mkdir -p "${remotePath}"`);
        const output = await sshExecWithRetry(hostIp, `ls -lA "${remotePath}"`);
        const lines = output.trim().split('\n');
        const entries = [];
        const lineRegex = /^([d\-l])\S+\s+\d+\s+\S+\s+\S+\s+(\d+)\s+\w+\s+\d+\s+[\d:]+\s+(.+)$/;
        for (const line of lines) {
            const match = line.match(lineRegex);
            if (match) {
                entries.push({
                    name: match[3],
                    isDirectory: match[1] === 'd',
                    size: parseInt(match[2], 10)
                });
            }
        }
        // Sort: directories first, then alphabetical
        entries.sort((a, b) => {
            if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
            return a.name.localeCompare(b.name);
        });
        return entries;
    } catch (err) {
        console.error('[DEBUG] listRemoteDir error:', err.message);
        throw new Error(`Failed to list remote directory: ${err.message}`);
    }
}

async function deleteRemotePath(hostname, remotePath) {
    try {
        // Validate path is within schwung directory
        if (!remotePath.startsWith('/data/UserData/schwung/')) {
            throw new Error('Path must be within /data/UserData/schwung/');
        }
        const hostIp = cachedDeviceIp || hostname;
        await sshExecWithRetry(hostIp, `rm -rf "${remotePath}"`);
        return true;
    } catch (err) {
        console.error('[DEBUG] deleteRemotePath error:', err.message);
        throw new Error(`Failed to delete remote path: ${err.message}`);
    }
}

async function createRemoteDir(hostname, remotePath) {
    try {
        // Validate path is within schwung directory
        if (!remotePath.startsWith('/data/UserData/schwung/')) {
            throw new Error('Path must be within /data/UserData/schwung/');
        }
        const hostIp = cachedDeviceIp || hostname;
        await sshExecWithRetry(hostIp, `mkdir -p "${remotePath}"`);
        return true;
    } catch (err) {
        console.error('[DEBUG] createRemoteDir error:', err.message);
        throw new Error(`Failed to create remote directory: ${err.message}`);
    }
}

async function checkCoreInstallation(hostname) {
    try {
        const hostIp = cachedDeviceIp || hostname;
        console.log('[DEBUG] Checking if Schwung is installed...');

        // Quick check: is Schwung installed?
        const installCheck = await sshExecWithRetry(hostIp, 'test -d /data/UserData/schwung && echo "installed" || echo "not_installed"');
        if (installCheck.trim() === 'not_installed') {
            console.log('[DEBUG] Schwung not installed');
            return { installed: false, core: null };
        }

        // Get core version only
        let coreVersion = null;
        try {
            const versionOutput = await sshExecWithRetry(hostIp, 'cat /data/UserData/schwung/host/version.txt 2>/dev/null || cat /data/UserData/schwung/version.txt 2>/dev/null || echo ""');
            coreVersion = versionOutput.trim() || null;
            console.log('[DEBUG] Core version:', coreVersion);
        } catch (err) {
            console.log('[DEBUG] Could not read core version:', err.message);
        }

        return { installed: true, core: coreVersion };
    } catch (err) {
        console.error('[DEBUG] Error checking core installation:', err.message);
        throw new Error(`Failed to check installation: ${err.message}`);
    }
}

async function checkShimActive(hostname) {
    try {
        const hostIp = cachedDeviceIp || hostname;
        console.log('[DEBUG] Checking if shim is active (Move entrypoint type)...');

        // First, check the currently running Move process maps for shim preload.
        // This is the strongest signal and works for legacy/pre-backup installs too.
        let runtimeState = 'unknown';
        try {
            const runtimeProbe = "pid=\\$(pidof MoveOriginal 2>/dev/null | awk '{print \\$1}'); " +
                "if [ -z \"\\$pid\" ]; then pid=\\$(pidof Move 2>/dev/null | awk '{print \\$1}'); fi; " +
                "if [ -z \"\\$pid\" ]; then echo \"no_process\"; " +
                "elif grep -q \"schwung-shim.so\" /proc/\\$pid/maps 2>/dev/null; then echo \"active\"; " +
                "else echo \"inactive\"; fi";
            runtimeState = (await sshExecWithRetry(hostIp, runtimeProbe, { username: 'root' })).trim();
            console.log('[DEBUG] Shim runtime probe:', runtimeState);
            if (runtimeState === 'active') {
                return { active: true };
            }
        } catch (runtimeErr) {
            console.log('[DEBUG] Shim runtime probe failed (non-fatal):', runtimeErr.message);
        }

        const readMagicCommand = [
            'if [ ! -e /opt/move/Move ]; then',
            '  echo "missing";',
            'elif [ ! -s /opt/move/Move ]; then',
            '  echo "empty";',
            'elif [ ! -r /opt/move/Move ]; then',
            '  echo "unreadable";',
            'else',
            '  hexdump -n 2 -v -e \'/1 "%02x"\' /opt/move/Move 2>/dev/null || echo "read_error";',
            'fi'
        ].join(' ');

        // First try with ableton (should work in normal cases)
        let magic = (await sshExecWithRetry(hostIp, readMagicCommand)).trim();
        console.log('[DEBUG] /opt/move/Move magic probe (ableton):', magic);

        // Fallback to root if read is inconclusive with ableton
        if (magic === 'missing' || magic === 'empty' || magic === 'unreadable' || magic === 'read_error' || !magic) {
            try {
                magic = (await sshExecWithRetry(hostIp, readMagicCommand, { username: 'root' })).trim();
                console.log('[DEBUG] /opt/move/Move magic probe (root fallback):', magic);
            } catch (rootErr) {
                console.log('[DEBUG] Root fallback probe failed:', rootErr.message);
            }
        }

        if (magic === '2321') {
            // #! = shell script = our shim entrypoint = active
            return { active: true };
        }
        if (magic === '7f45') {
            // \x7fE = ELF binary.
            // Treat as disabled only with corroborating evidence.
            if (runtimeState === 'inactive') {
                return { active: false };
            }

            let hasMoveOriginal = 'unknown';
            try {
                hasMoveOriginal = (await sshExecWithRetry(hostIp, 'test -f /opt/move/MoveOriginal && echo "yes" || echo "no"', { username: 'root' })).trim();
                console.log('[DEBUG] /opt/move/MoveOriginal exists:', hasMoveOriginal);
            } catch (backupErr) {
                console.log('[DEBUG] MoveOriginal check failed (non-fatal):', backupErr.message);
            }

            if (hasMoveOriginal === 'yes') {
                return { active: false };
            }

            // Legacy/pre-backup installs may still be active without MoveOriginal.
            console.log('[DEBUG] ELF magic without MoveOriginal; assuming legacy active state');
            return { active: true };
        }

        // Unknown/inconclusive should not be treated as disabled (causes false re-enable prompts)
        throw new Error(`Unable to determine shim status (magic probe result: ${magic || 'empty'})`);
    } catch (err) {
        console.error('[DEBUG] Error checking shim status:', err.message);
        throw new Error(`Failed to check shim status: ${err.message}`);
    }
}

async function reenableMoveEverything(hostname) {
    try {
        const hostIp = cachedDeviceIp || hostname;
        console.log('[DEBUG] Re-enabling Schwung (root partition operations only)...');

        // Verify data partition payload is intact
        const shimCheck = await sshExecWithRetry(hostIp, 'test -f /data/UserData/schwung/schwung-shim.so && echo "ok" || echo "missing"');
        if (shimCheck.trim() !== 'ok') {
            throw new Error('Shim not found on data partition. Run a full install instead.');
        }
        const entrypointCheck = await sshExecWithRetry(hostIp, 'test -f /data/UserData/schwung/shim-entrypoint.sh && echo "ok" || echo "missing"');
        if (entrypointCheck.trim() !== 'ok') {
            throw new Error('Entrypoint not found on data partition. Run a full install instead.');
        }

        // Clean stale ld.so.preload entries
        await sshExecWithRetry(hostIp, "if [ -f /etc/ld.so.preload ] && grep -q 'schwung-shim.so' /etc/ld.so.preload; then grep -v 'schwung-shim.so' /etc/ld.so.preload > /tmp/ld.so.preload.new || true; if [ -s /tmp/ld.so.preload.new ]; then cat /tmp/ld.so.preload.new > /etc/ld.so.preload; else rm -f /etc/ld.so.preload; fi; rm -f /tmp/ld.so.preload.new; fi", { username: 'root' });

        // Copy shim to /usr/lib/ + setuid
        // NOTE: must be a real copy, not a symlink — glibc 2.35+ follows symlinks under
        // AT_SECURE (triggered by MoveOriginal's file capabilities) and rejects libraries
        // whose real path is on an untrusted filesystem like /data/UserData/
        await sshExecWithRetry(hostIp, 'rm -f /usr/lib/schwung-shim.so && cp /data/UserData/schwung/schwung-shim.so /usr/lib/schwung-shim.so', { username: 'root' });
        await sshExecWithRetry(hostIp, 'chmod u+s /usr/lib/schwung-shim.so', { username: 'root' });
        const setuidCheck = await sshExecWithRetry(hostIp, 'test -u /usr/lib/schwung-shim.so && echo "ok" || echo "no"', { username: 'root' });
        if (setuidCheck.trim() !== 'ok') {
            throw new Error('Shim setuid bit missing after chmod');
        }

        // Web shim symlink if present
        const hasWebShim = await sshExecWithRetry(hostIp, 'test -f /data/UserData/schwung/schwung-web-shim.so && echo "yes" || echo "no"');
        if (hasWebShim.trim() === 'yes') {
            await sshExecWithRetry(hostIp, 'rm -f /usr/lib/schwung-web-shim.so && ln -s /data/UserData/schwung/schwung-web-shim.so /usr/lib/schwung-web-shim.so', { username: 'root' });
        }

        // TTS library symlinks if present
        const hasLib = await sshExecWithRetry(hostIp, 'test -d /data/UserData/schwung/lib && echo "yes" || echo "no"');
        if (hasLib.trim() === 'yes') {
            await sshExecWithRetry(hostIp, 'cd /data/UserData/schwung/lib && for lib in *.so.*; do [ -e "\\$lib" ] || continue; rm -f "/usr/lib/\\$lib" && ln -s "/data/UserData/schwung/lib/\\$lib" "/usr/lib/\\$lib"; done', { username: 'root' });
        }

        // Ensure entrypoint is executable
        await sshExecWithRetry(hostIp, 'chmod +x /data/UserData/schwung/shim-entrypoint.sh', { username: 'root' });

        // Backup original Move binary if MoveOriginal doesn't exist
        const hasMoveOriginal = await sshExecWithRetry(hostIp, 'test -f /opt/move/MoveOriginal && echo "yes" || echo "no"', { username: 'root' });
        if (hasMoveOriginal.trim() !== 'yes') {
            await sshExecWithRetry(hostIp, 'test -f /opt/move/Move && mv /opt/move/Move /opt/move/MoveOriginal', { username: 'root' });
            try { await sshExecWithRetry(hostIp, 'cp /opt/move/MoveOriginal ~/'); } catch (e) { /* non-fatal */ }
        }

        // Install shimmed entrypoint
        await sshExecWithRetry(hostIp, 'cp /data/UserData/schwung/shim-entrypoint.sh /opt/move/Move', { username: 'root' });

        // MoveWebService wrapper if web shim present
        if (hasWebShim.trim() === 'yes') {
            try {
                const webSvcPath = (await sshExecWithRetry(hostIp, "grep 'service_path=' /etc/init.d/move-web-service 2>/dev/null | head -n 1 | sed 's/.*service_path=//' | tr -d '[:space:]'", { username: 'root' })).trim();
                if (webSvcPath) {
                    const hasOriginal = await sshExecWithRetry(hostIp, `test -f ${webSvcPath}Original && echo "yes" || echo "no"`, { username: 'root' });
                    if (hasOriginal.trim() !== 'yes') {
                        await sshExecWithRetry(hostIp, `mv ${webSvcPath} ${webSvcPath}Original`, { username: 'root' });
                    }
                    await sshExecWithRetry(hostIp, `cat > ${webSvcPath} << 'WEOF'\n#!/bin/sh\nexport LD_LIBRARY_PATH=/data/UserData/schwung/lib:\\$LD_LIBRARY_PATH\nexport LD_PRELOAD=/usr/lib/schwung-web-shim.so\nexec ${webSvcPath}Original "\\$@"\nWEOF\nchmod +x ${webSvcPath}`, { username: 'root' });
                }
            } catch (err) {
                console.log('[DEBUG] Web service wrapper setup failed (non-fatal):', err.message);
            }
        }

        // Stop and restart Move service
        console.log('[DEBUG] Restarting Move service...');
        await sshExecWithRetry(hostIp, '/etc/init.d/move stop >/dev/null 2>&1 || true', { username: 'root' });
        await sshExecWithRetry(hostIp, 'for name in MoveOriginal Move MoveLauncher MoveMessageDisplay shadow_ui schwung link-subscriber display-server; do pids=\\$(pidof \\$name 2>/dev/null || true); if [ -n "\\$pids" ]; then kill -9 \\$pids 2>/dev/null || true; fi; done', { username: 'root' });
        await sshExecWithRetry(hostIp, 'rm -f /dev/shm/move-shadow-* /dev/shm/move-display-*', { username: 'root' });
        await sshExecWithRetry(hostIp, 'pids=\\$(fuser /dev/ablspi0.0 2>/dev/null || true); if [ -n "\\$pids" ]; then kill -9 \\$pids || true; fi', { username: 'root' });
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Restart MoveWebService if wrapped
        if (hasWebShim.trim() === 'yes') {
            try {
                const webSvcPath = (await sshExecWithRetry(hostIp, "grep 'service_path=' /etc/init.d/move-web-service 2>/dev/null | head -n 1 | sed 's/.*service_path=//' | tr -d '[:space:]'", { username: 'root' })).trim();
                if (webSvcPath) {
                    const hasOriginal = await sshExecWithRetry(hostIp, `test -f ${webSvcPath}Original && echo "yes" || echo "no"`, { username: 'root' });
                    if (hasOriginal.trim() === 'yes') {
                        await sshExecWithRetry(hostIp, 'killall MoveWebServiceOriginal MoveWebService 2>/dev/null; sleep 1; /etc/init.d/move-web-service start >/dev/null 2>&1 || true', { username: 'root' });
                    }
                }
            } catch (err) {
                console.log('[DEBUG] Web service restart failed (non-fatal):', err.message);
            }
        }

        await sshExecWithRetry(hostIp, '/etc/init.d/move start >/dev/null 2>&1', { username: 'root' });

        // Verify shim is loaded (wait up to 30 seconds)
        let shimOk = false;
        for (let i = 0; i < 30; i++) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            try {
                const check = await sshExec(hostIp, 'pid=\\$(pidof MoveOriginal 2>/dev/null | awk \'{print \\$1}\'); test -n "\\$pid" && grep -q "schwung-shim.so" /proc/\\$pid/maps && echo "ok" || echo "no"', { username: 'root' });
                if (check.trim() === 'ok') {
                    shimOk = true;
                    break;
                }
            } catch (err) {
                // Keep trying
            }
        }

        if (!shimOk) {
            throw new Error('Move started without active shim. Try a full reinstall.');
        }

        console.log('[DEBUG] Re-enable complete!');
        return { success: true };
    } catch (err) {
        console.error('[DEBUG] Re-enable failed:', err.message);
        throw err;
    }
}

async function checkInstalledVersions(hostname, progressCallback = null) {
    try {
        const hostIp = cachedDeviceIp || hostname;
        console.log('[DEBUG] Checking installed versions on device...');

        // Check if Schwung is installed
        const installCheck = await sshExecWithRetry(hostIp, 'test -d /data/UserData/schwung && echo "installed" || echo "not_installed"');
        if (installCheck.trim() === 'not_installed') {
            console.log('[DEBUG] Schwung not installed on device');
            return {
                installed: false,
                core: null,
                modules: []
            };
        }

        // Get core version
        let coreVersion = null;
        try {
            if (progressCallback) progressCallback('Checking core version...');
            const versionOutput = await sshExecWithRetry(hostIp, 'cat /data/UserData/schwung/host/version.txt 2>/dev/null || cat /data/UserData/schwung/version.txt 2>/dev/null || echo ""');
            coreVersion = versionOutput.trim() || null;
            console.log('[DEBUG] Core version:', coreVersion);
        } catch (err) {
            console.log('[DEBUG] Could not read core version:', err.message);
        }

        // Find all installed modules (single SSH command reads all module.json files at once)
        const modules = [];
        try {
            if (progressCallback) progressCallback('Finding installed modules...');

            // Find all module.json files and cat them in one shot, separated by a delimiter
            // This replaces 65+ sequential SSH commands with a single one
            // Uses -exec directly (no shell variables) to avoid quoting issues with sshExec
            const DELIM = '___MODULE_BOUNDARY___';
            const batchOutput = await sshExecWithRetry(hostIp,
                'find /data/UserData/schwung/modules -name module.json -type f -exec cat {} \\; -exec echo ___MODULE_BOUNDARY___ \\;'
            );

            const chunks = batchOutput.split(DELIM).map(c => c.trim()).filter(c => c);
            console.log(`[DEBUG] Found ${chunks.length} module.json files`);

            for (const chunk of chunks) {
                try {
                    const moduleInfo = JSON.parse(chunk);

                    if (moduleInfo.id && moduleInfo.version) {
                        const moduleData = {
                            id: moduleInfo.id,
                            name: moduleInfo.name || moduleInfo.id,
                            version: moduleInfo.version,
                            component_type: moduleInfo.component_type
                                || (moduleInfo.capabilities && moduleInfo.capabilities.component_type)
                                || 'utility'
                        };
                        // Include assets info if declared
                        if (moduleInfo.assets) {
                            moduleData.assets = moduleInfo.assets;
                        }
                        modules.push(moduleData);
                        console.log(`[DEBUG] Found module: ${moduleInfo.id} v${moduleInfo.version}`);
                    }
                } catch (err) {
                    console.log(`[DEBUG] Error parsing module.json chunk:`, err.message);
                }
            }

            if (progressCallback) progressCallback(`Found ${modules.length} modules`);
        } catch (err) {
            console.log('[DEBUG] Error finding modules:', err.message);
        }

        return {
            installed: true,
            core: coreVersion,
            modules
        };
    } catch (err) {
        console.error('[DEBUG] Error checking installed versions:', err.message);
        throw new Error(`Failed to check installed versions: ${err.message}`);
    }
}

function isNewerVersion(candidate, current) {
    const parse = (v) => (v || '').replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
    const a = parse(candidate);
    const b = parse(current);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const av = a[i] || 0;
        const bv = b[i] || 0;
        if (av > bv) return true;
        if (av < bv) return false;
    }
    return false;
}

function compareVersions(installed, latestRelease, moduleCatalog) {
    const result = {
        coreUpgrade: null,
        upgradableModules: [],
        upToDateModules: [],
        newModules: []
    };

    // Compare core version
    if (installed.core && latestRelease.version && isNewerVersion(latestRelease.version, installed.core)) {
        result.coreUpgrade = {
            current: installed.core,
            available: latestRelease.version
        };
    }

    // Create map of installed modules by id
    const installedMap = new Map(installed.modules.map(m => [m.id, m]));

    // Check each module in catalog
    for (const catalogModule of moduleCatalog) {
        const installedModule = installedMap.get(catalogModule.id);

        if (installedModule) {
            // Merge: catalog provides base, device module.json can override assets
            const merged = {
                ...catalogModule,
                currentVersion: installedModule.version
            };
            // Prefer device-side assets over catalog (allows updates without catalog changes)
            if (installedModule.assets) {
                merged.assets = installedModule.assets;
            }

            // Module is installed - check if catalog version is newer
            if (catalogModule.version && isNewerVersion(catalogModule.version, installedModule.version)) {
                result.upgradableModules.push(merged);
            } else {
                result.upToDateModules.push(merged);
            }
        } else {
            // Module not installed - it's new
            result.newModules.push(catalogModule);
        }
    }

    return result;
}

function getDiagnostics(deviceIp, errors) {
    const diagnostics = {
        timestamp: new Date().toISOString(),
        platform: os.platform(),
        arch: os.arch(),
        deviceIp,
        errors,
        sshKeyExists: !!getUsablePrivateKeyPath(),
        hasCookie: !!savedCookie
    };

    return JSON.stringify(diagnostics, null, 2);
}

async function getScreenReaderStatus(hostname) {
    try {
        const hostIp = cachedDeviceIp || hostname;

        // Check for screen reader state file (used by tts_engine_flite.c)
        const checkCmd = 'cat /data/UserData/schwung/config/screen_reader_state.txt 2>/dev/null || echo "0"';
        const status = (await sshExecWithRetry(hostIp, checkCmd)).trim();

        return status === '1';
    } catch (err) {
        console.log('[DEBUG] Could not read screen reader status:', err.message);
        return false;
    }
}

async function setScreenReaderState(hostname, enabled) {
    try {
        const hostIp = cachedDeviceIp || hostname;
        console.log('[DEBUG] Setting screen reader to:', enabled);

        // Ensure config directory exists
        await sshExecWithRetry(hostIp, 'mkdir -p /data/UserData/schwung/config');

        // Write state file (1 = enabled, 0 = disabled)
        const value = enabled ? '1' : '0';
        await sshExecWithRetry(hostIp, `echo "${value}" > /data/UserData/schwung/config/screen_reader_state.txt`);

        // Restart Move via init service so it picks up the new state
        // (matches the restart sequence in install.sh)
        console.log('[DEBUG] Restarting Move...');
        await sshExecWithRetry(hostIp, '/etc/init.d/move stop >/dev/null 2>&1 || true', { username: 'root' });
        await sshExecWithRetry(hostIp, 'for name in MoveOriginal Move MoveLauncher MoveMessageDisplay shadow_ui schwung link-subscriber display-server; do pids=$(pidof $name 2>/dev/null || true); if [ -n "$pids" ]; then kill -9 $pids 2>/dev/null || true; fi; done', { username: 'root' });
        await sshExecWithRetry(hostIp, 'rm -f /dev/shm/move-shadow-* /dev/shm/move-display-*', { username: 'root' });
        await sshExecWithRetry(hostIp, 'pids=$(fuser /dev/ablspi0.0 2>/dev/null || true); if [ -n "$pids" ]; then kill -9 $pids || true; fi', { username: 'root' });
        await new Promise(resolve => setTimeout(resolve, 2000));
        await sshExecWithRetry(hostIp, '/etc/init.d/move start >/dev/null 2>&1', { username: 'root' });

        return {
            enabled: enabled,
            message: `Screen reader ${enabled ? 'enabled' : 'disabled'}. Move is restarting.`
        };
    } catch (err) {
        console.error('[DEBUG] Screen reader toggle error:', err.message);
        throw new Error(`Failed to set screen reader state: ${err.message}`);
    }
}

async function uploadModuleAssets(localPaths, remoteDir, hostname) {
    try {
        const hostIp = cachedDeviceIp || hostname;
        console.log(`[DEBUG] Uploading ${localPaths.length} asset(s) to ${remoteDir}`);

        // Ensure remote directory exists
        await sshExecWithRetry(hostIp, `mkdir -p "${remoteDir}"`);

        const results = [];

        async function uploadEntry(localPath, targetDir, isTopLevel = false) {
            const stat = fs.statSync(localPath);
            if (stat.isDirectory()) {
                // For top-level selected folders, upload contents directly into targetDir
                // (avoids roms/roms when user selects a "roms" folder to upload into "roms/")
                // For nested subdirectories, preserve the folder structure
                let remoteSubdir;
                if (isTopLevel) {
                    remoteSubdir = targetDir;
                    console.log(`[DEBUG] Uploading contents of ${path.basename(localPath)}/ into ${remoteSubdir}`);
                } else {
                    const folderName = path.basename(localPath);
                    remoteSubdir = `${targetDir}/${folderName}`;
                    await sshExecWithRetry(hostIp, `mkdir -p "${remoteSubdir}"`);
                    console.log(`[DEBUG] Created remote dir ${remoteSubdir}`);
                }

                const entries = fs.readdirSync(localPath);
                for (const entry of entries) {
                    await uploadEntry(path.join(localPath, entry), remoteSubdir, false);
                }
                results.push({ file: path.basename(localPath) + '/', success: true });
            } else {
                const filename = path.basename(localPath);
                const remotePath = `${targetDir}/${filename}`;
                console.log(`[DEBUG] Uploading ${filename}...`);
                try {
                    await sftpUpload(hostIp, localPath, remotePath);
                    results.push({ file: filename, success: true });
                    console.log(`[DEBUG] Uploaded ${filename}`);
                } catch (err) {
                    console.error(`[DEBUG] Failed to upload ${filename}:`, err.message);
                    results.push({ file: filename, success: false, error: err.message });
                }
            }
        }

        for (const localPath of localPaths) {
            await uploadEntry(localPath, remoteDir, true);
        }

        return results;
    } catch (err) {
        console.error('[DEBUG] Asset upload error:', err.message);
        throw new Error(`Asset upload failed: ${err.message}`);
    }
}

async function removeModulePackage(moduleId, componentType, hostname) {
    try {
        const hostIp = cachedDeviceIp || hostname;
        console.log(`[DEBUG] Removing module ${moduleId} (${componentType}) from device`);

        const categoryPath = getInstallSubdir(componentType);
        const modulePath = `/data/UserData/schwung/modules/${categoryPath}/${moduleId}`;

        // Verify the directory exists before removing
        const checkResult = await sshExecWithRetry(hostIp, `test -d "${modulePath}" && echo "exists" || echo "not_found"`);
        if (checkResult.trim() !== 'exists') {
            throw new Error(`Module directory not found: ${modulePath}`);
        }

        await sshExecWithRetry(hostIp, `rm -rf "${modulePath}"`);
        console.log(`[DEBUG] Module ${moduleId} removed successfully`);

        return true;
    } catch (err) {
        console.error(`[DEBUG] Module removal error for ${moduleId}:`, err.message);
        throw new Error(`Module removal failed: ${err.message}`);
    }
}

async function fixPermissions(hostname) {
    try {
        const hostIp = cachedDeviceIp || hostname;
        console.log('[DEBUG] Fixing file permissions on device...');

        // Ensure all files in schwung are owned by ableton
        // Use root to fix any files that may have been created with wrong ownership
        await sshExecWithRetry(hostIp, 'chown -R ableton:users /data/UserData/schwung/', { username: 'root' });

        // Fix ownership of UserLibrary paths created by root-running DSP plugins
        // (recordings, samples, track presets). Without this, tools like Wave Edit
        // can't cp/mv files written by the setuid shim.
        await sshExecWithRetry(hostIp, "chown -R ableton:users '/data/UserData/UserLibrary/Samples/Schwung' 2>/dev/null || true", { username: 'root' });
        await sshExecWithRetry(hostIp, "chown -R ableton:users '/data/UserData/UserLibrary/Track Presets/Schwung' 2>/dev/null || true", { username: 'root' });

        // Ensure shim has setuid bit (critical for LD_PRELOAD to work)
        await sshExecWithRetry(hostIp, 'chmod u+s /data/UserData/schwung/schwung-shim.so', { username: 'root' });

        // Ensure executables are executable
        await sshExecWithRetry(hostIp, 'chmod +x /data/UserData/schwung/schwung /data/UserData/schwung/shim-entrypoint.sh /data/UserData/schwung/start.sh /data/UserData/schwung/stop.sh', { username: 'root' });

        console.log('[DEBUG] Permissions fixed');
        return { success: true };
    } catch (err) {
        console.error('[DEBUG] Fix permissions error:', err.message);
        throw new Error(`Failed to fix permissions: ${err.message}`);
    }
}

async function uninstallMoveEverything(hostname) {
    try {
        const hostIp = cachedDeviceIp || hostname;
        console.log('[DEBUG] Uninstalling Schwung from:', hostIp);

        const asRoot = { username: 'root' };

        // Stop schwung service
        console.log('[DEBUG] Stopping schwung service...');
        await sshExecWithRetry(hostIp, 'systemctl stop schwung 2>/dev/null || killall schwung 2>/dev/null || true', asRoot);

        // Remove shim from /usr/lib if it exists
        console.log('[DEBUG] Removing shim library...');
        await sshExecWithRetry(hostIp, 'rm -f /usr/lib/schwung-shim.so', asRoot);

        // Remove Schwung directory
        console.log('[DEBUG] Removing Schwung files...');
        await sshExecWithRetry(hostIp, 'rm -rf /data/UserData/schwung', asRoot);

        // Restore original Move binary if backup exists
        console.log('[DEBUG] Restoring original Move binary...');
        const restoreCmd = `
            if [ -f /opt/move/MoveOriginal ]; then
                mv /opt/move/MoveOriginal /opt/move/Move
                echo "restored"
            else
                echo "no_backup"
            fi
        `;
        const restoreResult = (await sshExecWithRetry(hostIp, restoreCmd, asRoot)).trim();

        if (restoreResult === 'no_backup') {
            console.log('[DEBUG] No backup found, original Move binary may already be in place');
        }

        // Restart the device
        console.log('[DEBUG] Restarting device...');
        await sshExecWithRetry(hostIp, 'reboot', asRoot);

        console.log('[DEBUG] Uninstall complete');
        return {
            success: true,
            message: 'Schwung has been uninstalled. Your Move is restarting and will boot to stock firmware.'
        };
    } catch (err) {
        console.error('[DEBUG] Uninstall error:', err.message);
        throw new Error(`Failed to uninstall: ${err.message}`);
    }
}

async function testSshFormats(cookie) {
    const results = [];
    const testDir = path.join(os.tmpdir(), 'ssh-test');
    const sshpk = require('sshpk');

    try {
        await mkdir(testDir, { recursive: true });
    } catch (err) {
        // Ignore if exists
    }

    console.log('[TEST] Starting SSH format tests...');
    console.log('[TEST] Device IP:', cachedDeviceIp);

    if (!cachedDeviceIp) {
        return [{ error: 'Must connect to device first (cachedDeviceIp not set)' }];
    }

    const deviceUrl = `http://${cachedDeviceIp}`;

    // Test 1: Ed25519 with sshpk (OpenSSH format)
    try {
        console.log('[TEST] Testing Ed25519 with sshpk (OpenSSH format)...');
        const keyPath = path.join(testDir, 'test_ed25519_sshpk');

        const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
        const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
        const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });

        const sshpkPrivateKey = sshpk.parsePrivateKey(privateKeyPem, 'pem');
        const sshpkPublicKey = sshpk.parseKey(publicKeyPem, 'pem');

        const privateKeyOpenSSH = sshpkPrivateKey.toString('openssh');
        const pubkey = sshpkPublicKey.toString('ssh') + ' test';

        fs.writeFileSync(keyPath, privateKeyOpenSSH);

        const result = {
            name: 'Ed25519 OpenSSH (via sshpk)',
            privateKeyLength: privateKeyOpenSSH.length,
            publicKey: pubkey.substring(0, 80) + '...',
            apiAccepted: false,
            nativeSshWorks: false,
            ssh2Works: false,
            errors: []
        };

        // Test API submission
        try {
            const pubkeyClean = pubkey.trim().split(' ').slice(0, 2).join(' ');
            const response = await httpClient.post(`${deviceUrl}/api/v1/ssh`, pubkeyClean, {
                headers: { 'Cookie': cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
                timeout: 5000
            });
            result.apiAccepted = response.status === 200;
        } catch (err) {
            result.errors.push(`API: ${err.response?.status} - ${JSON.stringify(err.response?.data)}`);
        }

        // Test native SSH
        try {
            const { exec } = require('child_process');
            const { promisify } = require('util');
            const execAsync = promisify(exec);
            const sshCmd = `ssh -i "${keyPath}" -o StrictHostKeyChecking=no -o ConnectTimeout=3 -o BatchMode=yes ableton@${cachedDeviceIp} "echo test"`;
            const { stdout } = await execAsync(sshCmd, { timeout: 5000 });
            result.nativeSshWorks = stdout.trim() === 'test';
        } catch (err) {
            result.errors.push(`Native SSH: ${(err.stderr || err.message).substring(0, 100)}`);
        }

        // Test ssh2
        try {
            const Client = require('ssh2').Client;
            const conn = new Client();
            const connected = await new Promise((resolve) => {
                const timeout = setTimeout(() => { conn.end(); resolve(false); }, 3000);
                conn.on('ready', () => { clearTimeout(timeout); conn.end(); resolve(true); });
                conn.on('error', () => { clearTimeout(timeout); resolve(false); });
                conn.connect({
                    host: cachedDeviceIp,
                    port: 22,
                    username: 'ableton',
                    privateKey: Buffer.from(privateKeyOpenSSH),
                    readyTimeout: 3000
                });
            });
            result.ssh2Works = connected;
        } catch (err) {
            result.errors.push(`ssh2: ${err.message}`);
        }

        results.push(result);
    } catch (err) {
        results.push({ name: 'Ed25519 OpenSSH (via sshpk)', error: err.message });
    }

    // Test 2: RSA with sshpk
    try {
        console.log('[TEST] Testing RSA with sshpk...');
        const keyPath = path.join(testDir, 'test_rsa_sshpk');

        const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
        const privateKeyPem = privateKey.export({ type: 'pkcs1', format: 'pem' });
        const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });

        const sshpkPrivateKey = sshpk.parsePrivateKey(privateKeyPem, 'pem');
        const sshpkPublicKey = sshpk.parseKey(publicKeyPem, 'pem');

        const privateKeyOpenSSH = sshpkPrivateKey.toString('openssh');
        const pubkey = sshpkPublicKey.toString('ssh') + ' test';

        fs.writeFileSync(keyPath, privateKeyOpenSSH);

        const result = {
            name: 'RSA OpenSSH (via sshpk)',
            privateKeyLength: privateKeyOpenSSH.length,
            publicKey: pubkey.substring(0, 80) + '...',
            apiAccepted: false,
            nativeSshWorks: false,
            ssh2Works: false,
            errors: []
        };

        // Test API submission
        try {
            const pubkeyClean = pubkey.trim().split(' ').slice(0, 2).join(' ');
            const response = await httpClient.post(`${deviceUrl}/api/v1/ssh`, pubkeyClean, {
                headers: { 'Cookie': cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
                timeout: 5000
            });
            result.apiAccepted = response.status === 200;
        } catch (err) {
            result.errors.push(`API: ${err.response?.status} - ${JSON.stringify(err.response?.data)}`);
        }

        // Test native SSH (skip - not submitted to device)
        result.nativeSshWorks = null;
        result.ssh2Works = null;

        results.push(result);
    } catch (err) {
        results.push({ name: 'RSA OpenSSH (via sshpk)', error: err.message });
    }

    // Test 3: Ed25519 PKCS8 PEM (old approach)
    try {
        console.log('[TEST] Testing Ed25519 PKCS8 PEM...');
        const keyPath = path.join(testDir, 'test_ed25519_pkcs8');

        const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
            publicKeyEncoding: { type: 'spki', format: 'pem' },
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
        });

        const publicKeyObj = crypto.createPublicKey(publicKey);
        const publicKeyDer = publicKeyObj.export({ type: 'spki', format: 'der' });
        const publicKeyRaw = publicKeyDer.slice(-32);

        const typeBytes = Buffer.from('ssh-ed25519');
        const typeLength = Buffer.alloc(4);
        typeLength.writeUInt32BE(typeBytes.length, 0);
        const keyLength = Buffer.alloc(4);
        keyLength.writeUInt32BE(publicKeyRaw.length, 0);
        const sshPublicKey = Buffer.concat([typeLength, typeBytes, keyLength, publicKeyRaw]);
        const pubkey = `ssh-ed25519 ${sshPublicKey.toString('base64')} test`;

        fs.writeFileSync(keyPath, privateKey);

        const result = {
            name: 'Ed25519 PKCS8 PEM',
            privateKeyLength: privateKey.length,
            publicKey: pubkey.substring(0, 80) + '...',
            apiAccepted: false,
            nativeSshWorks: false,
            ssh2Works: false,
            errors: []
        };

        // Test API submission
        try {
            const pubkeyClean = pubkey.trim().split(' ').slice(0, 2).join(' ');
            const response = await httpClient.post(`${deviceUrl}/api/v1/ssh`, pubkeyClean, {
                headers: { 'Cookie': cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
                timeout: 5000
            });
            result.apiAccepted = response.status === 200;
        } catch (err) {
            result.errors.push(`API: ${err.response?.status} - ${JSON.stringify(err.response?.data)}`);
        }

        // Test native SSH
        try {
            const { exec } = require('child_process');
            const { promisify } = require('util');
            const execAsync = promisify(exec);
            const sshCmd = `ssh -i "${keyPath}" -o StrictHostKeyChecking=no -o ConnectTimeout=3 -o BatchMode=yes ableton@${cachedDeviceIp} "echo test"`;
            const { stdout } = await execAsync(sshCmd, { timeout: 5000 });
            result.nativeSshWorks = stdout.trim() === 'test';
        } catch (err) {
            const errorMsg = err.stderr || err.message;
            if (errorMsg.includes('invalid format')) {
                result.errors.push('Native SSH: invalid key format');
            } else {
                result.errors.push(`Native SSH: ${errorMsg.substring(0, 100)}`);
            }
        }

        // Test ssh2
        try {
            const Client = require('ssh2').Client;
            const conn = new Client();
            const connected = await new Promise((resolve) => {
                const timeout = setTimeout(() => { conn.end(); resolve(false); }, 3000);
                conn.on('ready', () => { clearTimeout(timeout); conn.end(); resolve(true); });
                conn.on('error', () => { clearTimeout(timeout); resolve(false); });
                conn.connect({
                    host: cachedDeviceIp,
                    port: 22,
                    username: 'ableton',
                    privateKey: Buffer.from(privateKey),
                    readyTimeout: 3000
                });
            });
            result.ssh2Works = connected;
        } catch (err) {
            result.errors.push(`ssh2: ${err.message}`);
        }

        results.push(result);
    } catch (err) {
        results.push({ name: 'Ed25519 PKCS8 PEM', error: err.message });
    }

    console.log('[TEST] Test results:', JSON.stringify(results, null, 2));
    return results;
}

// --- WiFi Management Helpers ---

function parseServiceLine(line) {
    if (!line || !line.trim()) return null;
    // Flags are at fixed positions in the raw line (before trimming):
    // pos 0: '*' (favorite/saved), pos 1: 'A' (auto-connect), pos 2: 'O'/'R' (state)
    const flagChars = line.substring(0, 4);
    const isSaved = flagChars[0] === '*';
    const isAutoConnect = flagChars[1] === 'A';
    const isReady = flagChars[2] === 'R';
    const isOnline = flagChars[2] === 'O';
    const rest = line.substring(4).trim();
    // Service ID is always the last whitespace-delimited token starting with wifi_
    const tokens = rest.split(/\s+/);
    const serviceId = [...tokens].reverse().find(t => t.startsWith('wifi_'));
    if (!serviceId) return null;
    // Network name is everything before the service ID
    const nameEnd = rest.lastIndexOf(serviceId);
    const name = rest.substring(0, nameEnd).trim();
    // Derive security from service ID suffix
    let security = 'unknown';
    if (serviceId.endsWith('_psk')) security = 'WPA';
    else if (serviceId.endsWith('_wep')) security = 'WEP';
    else if (serviceId.endsWith('_none')) security = 'open';
    else if (serviceId.includes('_ieee8021x')) security = 'Enterprise';
    return {
        name: name || '(Hidden Network)',
        serviceId,
        security,
        connected: isReady || isOnline,
        saved: isSaved,
        online: isOnline,
        ready: isReady
    };
}

function parseServices(output) {
    if (!output) return [];
    return output.split('\n').map(parseServiceLine).filter(Boolean);
}

function extractSsidFromServiceId(serviceId) {
    // Format: wifi_<mac>_<hexssid>_managed_<security>
    const parts = serviceId.split('_');
    // parts[0]=wifi, parts[1]=mac, parts[2]=hexssid, ...
    if (parts.length < 3) return serviceId;
    const hexSsid = parts[2];
    try {
        return Buffer.from(hexSsid, 'hex').toString('utf8');
    } catch {
        return hexSsid;
    }
}

function validateServiceId(serviceId) {
    if (!serviceId || !/^wifi_[a-z0-9_]+$/.test(serviceId)) {
        throw new Error(`Invalid service ID: ${serviceId}`);
    }
}

// --- WiFi Management Functions ---

async function wifiGetStatus(hostname) {
    const hostIp = cachedDeviceIp || hostname;
    let wifiEnabled = false;
    let connectedService = null;
    const isUsbConnection = cachedDeviceIp ? /^192\.168\.7\./.test(cachedDeviceIp) : false;

    try {
        const techOutput = await sshExecWithRetry(hostIp, 'connmanctl technologies');
        // Check if WiFi technology is powered on
        const wifiSection = techOutput.split('/net/connman/technology/wifi');
        if (wifiSection.length > 1) {
            const sectionText = wifiSection[1].split('/net/connman/technology/')[0] || wifiSection[1];
            wifiEnabled = /Powered\s*=\s*True/i.test(sectionText);
        }
    } catch (err) {
        console.log('[WIFI] Error checking technologies:', err.message);
    }

    try {
        const servicesOutput = await sshExecWithRetry(hostIp, 'connmanctl services');
        const services = parseServices(servicesOutput);
        connectedService = services.find(s => s.connected) || null;
    } catch (err) {
        console.log('[WIFI] Error listing services:', err.message);
    }

    return { wifiEnabled, connectedService, isUsbConnection };
}

async function wifiScan(hostname) {
    const hostIp = cachedDeviceIp || hostname;
    try {
        await sshExecWithRetry(hostIp, 'connmanctl scan wifi');
    } catch (err) {
        console.log('[WIFI] Scan command error (may be normal):', err.message);
    }
    // Wait for scan to complete
    await new Promise(resolve => setTimeout(resolve, 3000));
    const servicesOutput = await sshExecWithRetry(hostIp, 'connmanctl services');
    return parseServices(servicesOutput);
}

async function wifiListServices(hostname) {
    const hostIp = cachedDeviceIp || hostname;
    const servicesOutput = await sshExecWithRetry(hostIp, 'connmanctl services');
    return parseServices(servicesOutput);
}

async function wifiConnect(hostname, serviceId, passphrase) {
    validateServiceId(serviceId);
    const hostIp = cachedDeviceIp || hostname;
    // Connman on the Move stores service data in /data/settings/connman/lib/connman/
    const connmanDataDir = '/data/settings/connman/lib/connman';

    if (passphrase) {
        // Extract the hex SSID from the service ID (third underscore-delimited segment)
        const parts = serviceId.split('_');
        const hexSsid = parts.length >= 3 ? parts[2] : '';
        const ssid = extractSsidFromServiceId(serviceId);

        // Write a connman service settings file directly — same format as saved networks
        const settingsDir = `${connmanDataDir}/${serviceId}`;
        const settingsContent = `[${serviceId}]\nName=${ssid}\nSSID=${hexSsid}\nFavorite=true\nAutoConnect=true\nPassphrase=${passphrase}\nIPv4.method=dhcp\nIPv6.method=auto\nIPv6.privacy=disabled\n`;

        // Hex-encode the content so the shell command contains only safe [0-9a-f\\x] chars,
        // preventing any shell injection via passphrase (the device may lack base64)
        const settingsHex = Array.from(Buffer.from(settingsContent)).map(b => '\\x' + b.toString(16).padStart(2, '0')).join('');

        console.log('[WIFI] Writing service settings for:', ssid);
        try {
            await sshExecWithRetry(hostIp, `mkdir -p ${settingsDir}`, { username: 'root' });
            await sshExecWithRetry(hostIp, `printf '${settingsHex}' > ${settingsDir}/settings`, { username: 'root' });
        } catch (err) {
            throw new Error(`Failed to write WiFi settings: ${err.message}`);
        }

        // Connman only reads settings from disk at startup — restart it to load credentials,
        // then explicitly connect (otherwise it reconnects to the previous favorite).
        try {
            console.log('[WIFI] Restarting connman to pick up new credentials...');
            await sshExecWithRetry(hostIp, `/etc/init.d/connman restart`, { username: 'root' });
        } catch (err) {
            if (err.message && (err.message.includes('Timed out') || err.message.includes('ECONNRESET') || err.message.includes('Connection lost'))) {
                console.log('[WIFI] SSH dropped during connman restart (expected)');
            } else {
                throw new Error(`Failed to restart connman: ${err.message}`);
            }
        }
        // Wait for connman to come back and reconnect to WiFi
        await new Promise(resolve => setTimeout(resolve, 5000));
    }

    // Connect to the target network (works for new, open, and saved networks)
    try {
        console.log('[WIFI] Connecting to:', serviceId);
        await sshExecWithRetry(hostIp, `nohup connmanctl connect ${serviceId} > /dev/null 2>&1 &`);
    } catch (err) {
        if (err.message && (err.message.includes('Timed out') || err.message.includes('ECONNRESET') || err.message.includes('Connection lost'))) {
            console.log('[WIFI] SSH dropped during connect (expected when switching networks)');
            return;
        }
        throw new Error(`Failed to connect: ${err.message}`);
    }
}

async function wifiDisconnect(hostname, serviceId) {
    validateServiceId(serviceId);
    const hostIp = cachedDeviceIp || hostname;
    try {
        await sshExecWithRetry(hostIp, `nohup connmanctl disconnect ${serviceId} > /dev/null 2>&1 &`);
    } catch (err) {
        // SSH drop is expected when disconnecting the active WiFi network
        if (err.message && (err.message.includes('Timed out') || err.message.includes('ECONNRESET') || err.message.includes('Connection lost'))) {
            console.log('[WIFI] SSH dropped during disconnect (expected)');
            return;
        }
        throw err;
    }
}

async function wifiRemoveService(hostname, serviceId) {
    validateServiceId(serviceId);
    const hostIp = cachedDeviceIp || hostname;
    await sshExecWithRetry(hostIp, `connmanctl config ${serviceId} --remove`);
    // Also remove the service settings directory
    try {
        await sshExecWithRetry(hostIp, `rm -rf /data/settings/connman/lib/connman/${serviceId}`, { username: 'root' });
    } catch (err) {
        console.log('[WIFI] Error removing service directory:', err.message);
    }
}

async function wifiEnableRadio(hostname) {
    const hostIp = cachedDeviceIp || hostname;
    await sshExecWithRetry(hostIp, 'connmanctl enable wifi', { username: 'root' });
}

module.exports = {
    setMainWindow,
    validateDevice,
    getSavedCookie,
    clearSavedCookie,
    requestChallenge,
    submitAuthCode,
    findExistingSshKey,
    generateNewSshKey,
    readPublicKey,
    submitSshKeyWithAuth,
    testSsh,
    setupSshConfig,
    checkGitBashAvailable,
    getModuleCatalog,
    getLatestRelease,
    downloadRelease,
    installMain,
    installModulePackage,
    installModuleBatch,
    removeModulePackage,
    uploadModuleAssets,
    listRemoteDir,
    deleteRemotePath,
    createRemoteDir,
    downloadRemoteFile,
    checkCoreInstallation,
    checkShimActive,
    reenableMoveEverything,
    checkInstalledVersions,
    compareVersions,
    getDiagnostics,
    getScreenReaderStatus,
    setScreenReaderState,
    uninstallMoveEverything,
    testSshFormats,
    cleanDeviceTmp,
    fixPermissions,
    checkInstallerUpdate,
    clearDnsCache,
    wifiGetStatus,
    wifiScan,
    wifiListServices,
    wifiConnect,
    wifiDisconnect,
    wifiRemoveService,
    wifiEnableRadio
};
