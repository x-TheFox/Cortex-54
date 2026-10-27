---
title: Install Savant
---
# Install Savant

Download the installer for your computer from [your account](/account/) or straight from here. The app updates itself
after this; you only install once.

| Computer | Download |
|---|---|
| Mac with Apple silicon (M1 or later) | [Savant for Apple silicon (.dmg)](/download/Savant_darwin-aarch64.dmg) |
| Mac with Intel | [Savant for Intel Macs (.dmg)](/download/Savant_darwin-x86_64.dmg) |
| Windows 10 or 11 (64-bit) | [Savant installer (.exe)](/download/Savant_windows-x86_64-setup.exe) · [.msi](/download/Savant_windows-x86_64.msi) · [.msix](/download/Savant_windows-x86_64.msix) |
| Linux x64 | [AppImage](/download/Savant_linux-x86_64.AppImage) · [.deb](/download/Savant_linux-x86_64.deb) · [.rpm](/download/Savant_linux-x86_64.rpm) |
| Linux arm64 | [AppImage](/download/Savant_linux-aarch64.AppImage) · [.deb](/download/Savant_linux-aarch64.deb) |

Not sure which Mac you have? Apple menu → **About This Mac**: "Chip: Apple M…" means Apple silicon.

## macOS

1. Open the `.dmg` and drag **Savant** into **Applications**.
2. Open Savant from Applications. The first time, macOS may say it **can't check the app for malicious software**
   ("Apple could not verify…"). Savant isn't yet signed with an Apple Developer ID, so macOS asks once. To allow it:
   - Click **Done** (not "Move to Trash").
   - Open **System Settings → Privacy & Security**, scroll to **Security**, and click **Open Anyway** next to the
     message about Savant. Confirm with your password or Touch ID.
   - Open Savant again and click **Open**.
3. macOS remembers the choice. Updates install without asking again.

If **Open Anyway** doesn't appear (an older or managed Mac), open **Terminal** and run this once, then open Savant:

```
xattr -dr com.apple.quarantine /Applications/Savant.app
```

If macOS says the app **is damaged**, the download was interrupted: delete it, download again, and use the
**Open Anyway** steps above.

## Windows

1. Run `Savant_windows-x86_64-setup.exe`.
2. Windows SmartScreen may show **"Windows protected your PC"** because the installer isn't signed with a paid
   code-signing certificate. Click **More info**, then **Run anyway**. It asks once per download.
3. Follow the installer. Savant starts in the tray (bottom-right, near the clock).

Prefer an MSIX package (Windows 11)? Open PowerShell **as administrator** in your Downloads folder and run:

```
Add-AppxPackage -AllowUnsigned .\Savant_windows-x86_64.msix
```

MSIX installs update through the next MSIX, not inside the app.

## Linux

- **AppImage** (any distribution): make it executable and run it.

  ```
  chmod +x Savant_linux-x86_64.AppImage && ./Savant_linux-x86_64.AppImage
  ```

- **Debian/Ubuntu**: `sudo apt install ./Savant_linux-x86_64.deb`
- **Fedora/RHEL**: `sudo dnf install ./Savant_linux-x86_64.rpm`

The tray icon needs a desktop with a system tray (GNOME needs the AppIndicator extension).

## The research desk (optional) {#research}

Savant's research desk (screeners, forecasts, the weekly review) runs small Python jobs on your computer through
**uv**. The app works without it; with it, the robot gets more ideas and learns from its own record. Install uv once:

- macOS / Linux: `curl -LsSf https://astral.sh/uv/install.sh | sh`
- Windows (PowerShell): `powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"`

Then restart Savant. **Settings → Health** shows whether it was found.

## What the app keeps on your computer

Everything lives in one folder in your home directory (`~/.savant` on macOS and Linux, `%USERPROFILE%\.savant` on
Windows): settings, the journal, and your keys (or the system keychain, if you turn that on in Settings → Data).
Nothing is uploaded except your licence check (your licence key and a one-way fingerprint of the computer).

Next: **[Getting started](../getting-started/)**.
