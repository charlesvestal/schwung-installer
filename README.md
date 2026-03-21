# Schwung Installer

Desktop app for installing [Schwung](https://github.com/charlesvestal/schwung) on your Ableton Move.

## Requirements

- **Ableton Move** connected to the same WiFi network as your computer
- **macOS**, **Windows**, or **Linux**

### Windows Users: Git for Windows Required

The installer needs [Git for Windows](https://git-scm.com/download/win) to run the installation scripts. **Install it before running the installer.** The default installation options are fine — the installer only needs the Git Bash component that comes bundled with it.

## Download

Download the latest release for your platform from the [Releases page](https://github.com/charlesvestal/schwung-installer/releases):

| Platform | File |
|----------|------|
| macOS (Apple Silicon) | `Schwung Installer-*-mac-arm64.zip` |
| macOS (Intel) | `Schwung Installer-*-mac-x64.zip` |
| Windows (x64) | `Schwung Installer-*-win-x64.exe` |
| Windows (ARM64) | `Schwung Installer-*-win-arm64.exe` |
| Linux (x64) | `Schwung Installer-*-linux-x64.deb` |
| Linux (ARM64) | `Schwung Installer-*-linux-arm64.deb` |

## First-Time Setup

1. **Launch the installer** and accept the community-software disclaimer
2. **Connect to your Move** — the installer automatically finds it on your network. If auto-discovery fails, you can enter the IP address manually
3. **Enter the 6-digit code** shown on your Move's display
4. **Add SSH key** — the installer generates a secure key and sends it to your Move. Confirm by selecting "Yes" on Move's jog wheel
5. **Choose what to install** — select the core framework and any modules you want
6. **Wait for installation** — progress is shown as files are transferred to your Move

On subsequent runs, the installer remembers your device and skips the authentication steps.

## Managing Your Installation

When Schwung is already installed, the installer switches to management mode:

- **Install New Modules** — browse and install additional sound generators, effects, and utilities
- **Upgrade Core** — update to the latest version when available
- **Screen Reader** — toggle text-to-speech accessibility
- **Uninstall** — remove Schwung and restore stock firmware

## Troubleshooting

### Device Not Found
- Make sure Move is powered on and connected to the same WiFi network
- Try opening `http://move.local` in your browser to verify connectivity
- **Windows**: Make sure your network is set to "Private" (mDNS doesn't work on "Public" networks)
- Use manual IP entry if auto-discovery doesn't work

### Windows: "Git Bash is required" Error
- Download and install [Git for Windows](https://git-scm.com/download/win)
- Restart the installer after installation
- The default Git for Windows install options work — no special configuration needed

### SSH Connection Failed
- Confirm you selected "Yes" on Move's display when prompted
- Check that no firewall is blocking port 22
- Try uninstalling and re-pairing if the issue persists after a Move firmware update

### Installation Failed
- Ensure your Move has enough free storage space
- Check your network connection is stable
- Use "Export Debug Logs" (in the footer) to save diagnostic info for reporting issues

## Debug Logs

Every screen has an "Export Debug Logs" link in the footer. If you run into problems, export the logs and include them when [reporting an issue](https://github.com/charlesvestal/schwung-installer/issues).

## Development

### Setup
```bash
npm install
```

### Run
```bash
npm start
```

### Build
```bash
npm run build
```

Produces platform-specific packages in `dist/`.

## AI Assistance Disclaimer

This module is part of Schwung and was developed with AI assistance, including Claude, Codex, and other AI assistants.

All architecture, implementation, and release decisions are reviewed by human maintainers.  
AI-assisted content may still contain errors, so please validate functionality, security, and license compatibility before production use.
