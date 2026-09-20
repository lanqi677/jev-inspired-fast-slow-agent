# DeepSeek Harness Mobile GUI Agent

![Mobile GUI Agent cover](docs/images/dsh-mobile-gui-agent-cover.png)

[![CI](https://github.com/kunjinkao-os/dsh-mobile-gui-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/kunjinkao-os/dsh-mobile-gui-agent/actions/workflows/ci.yml)
[![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-0.1.0--rc.6-4B32C3)](https://github.com/deepseek-ai/deepseek-harness)
[![Android](https://img.shields.io/badge/Android-ADB-3DDC84?logo=android&logoColor=white)](https://developer.android.com/tools/adb)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

English | [中文](docs/README.zh.md) | [Changelog](CHANGELOG.md)

`dsh-mobile-gui-agent` is an installable DeepSeek Harness plugin for controlling Android devices through ADB. It adds a **mobile_gui_agent** entry to the Harness Web UI and drives every task through an observe → decide → act → verify loop.

The repository is a single publishable npm package. The bundle patch inserts one Cordis plugin row; that plugin composes the ADB Provider, the Phone Agent Consumer, the Phone tools, the Typert Remote adapter, and the browser client under one lifecycle.

## Quick start

Connect and authorize an Android device, then install the pinned release into the Harness Web profile:

```bash
adb devices -l
dsh plugin --profile web add github:kunjinkao-os/dsh-mobile-gui-agent#v0.2.1
dsh --profile web --dump-config
dsh --profile web
```

The device row must report `device`. The configuration dump must contain a `# == dsh-mobile-gui-agent` layer and one `dsh-mobile-gui-agent` row. For the clearest workflow, send one short ordinary message in the Harness conversation first, then select **mobile_gui_agent** and enter the real phone command in its **Task** field. Do not enter the phone command in the ordinary Harness conversation composer. See [Requirements](#requirements) and [Use](#use) before operating an account or a device containing personal data.

## Recommended workflow

1. Select a workspace and send a short initialization message in the ordinary Harness conversation, for example `Prepare a mobile task`.
2. Select the **mobile_gui_agent** conversation tab.
3. Select the connected device and enter the actual phone command only in the **Task** field inside **mobile_gui_agent**.
4. Select **Start** and follow the verified steps. Do not send the phone command through the ordinary conversation composer.

The blank-session toolbar launcher is also available, but the flow above makes the separation between Harness conversation messages and phone tasks explicit.

![mobile_gui_agent setting and enabling a 12:00 alarm](docs/images/mobile-gui-agent-alarm-task.png)

## Demos

Opening Android Settings and navigating to the Wi-Fi page:

![mobile_gui_agent opening Settings and navigating to Wi-Fi](docs/images/open-settings-wifi-demo.png)

Opening Taobao with `deepseek_mobile`:

![deepseek_mobile opening Taobao](docs/images/open-taobao-demo.png)

## Compatibility

- DeepSeek Harness: `^0.1.0-rc.5`
- Verified against upstream commit `47f943859bef60e4160492346772ded9b24f765a`
- Also built and tested against the published `0.1.0-rc.6` Harness packages
- Node.js: `^22.19.0 || >=24.0.0`
- Android: a physical device or emulator visible to `adb devices`

The package follows the upstream `dsh.bundle.patch` and `dsh.client` manifests. It does not patch the Harness Agent loop or require unpublished Phone packages.

## What it provides

- ADB discovery, wireless connection, screenshots, UIAutomator hierarchy capture, tap, long press, swipe, verified text input/replacement, keys, back, home, and package launch
- Screenshot and pruned semantic UI observations with observation-local element IDs
- Strict `phone_observe` and `phone_act` Harness tools
- One meaningful action per model turn followed by a fresh observation and deterministic verification
- stale-element protection, adaptive screen stabilization, stuck detection, step and time limits, and recoverable ADB errors
- Harness approval for semantic controls that can send, publish, delete, purchase, pay, transfer, call, install, or change account security
- A blank-session **mobile_gui_agent** launcher and Web conversation tab with device selection, wireless connection, screenshot refresh, task controls, action overlays, and verified steps
- A fake device and scripted state transitions for keyless Agent-loop tests

This plugin does not install an Android accessibility service. It combines ADB screenshots with the hierarchy produced by Android UIAutomator. Custom Canvas, WebView, game, and image-only controls may be visible in the screenshot even when they are absent from the hierarchy; the Agent can use vision-capable model input or an optional `PhoneVisionProvider` for those screens.

## Requirements

1. Install Android Platform Tools and confirm `adb version` works.
2. Enable Developer options and USB debugging on the Android device.
3. Authorize the computer when Android shows the RSA debugging prompt.
4. Confirm the device is usable:

   ```bash
   adb devices -l
   ```

   The selected row must report `device`, not `offline` or `unauthorized`.
5. Use a DeepSeek Harness Web profile. The **mobile_gui_agent** entry is a browser client contribution and therefore is not shown by a headless-only profile.

Root access and an APK installed on the phone are not required for observation, navigation, or printable ASCII input. Unicode input uses the external ADB Keyboard helper (`com.android.adbkeyboard/.AdbIME`). When that helper is installed, the plugin discovers it even if it is disabled, enables and selects it only for the Unicode operation, then restores the user's previous IME and enabled set. No model setup action or user interaction is needed. If the helper is truly absent, configure an absolute host path to a reviewed APK with `adb.unicodeImeApkPath`; the plugin never downloads an APK, and installation still requires explicit Harness approval.

## Installation options

To install a local checkout into the standard Web profile:

```bash
dsh plugin --profile web add ./dsh-mobile-gui-agent
dsh --profile web --dump-config
dsh --profile web
```

When running Harness from its source checkout, use `pnpm dsh` in place of `dsh`:

```bash
pnpm dsh plugin --profile web add ../dsh-mobile-gui-agent
pnpm dsh --profile web --dump-config
pnpm dsh --profile web
```

The dump must contain a `# == dsh-mobile-gui-agent` layer and one row named `dsh-mobile-gui-agent`. Open the Web UI and select a workspace. The blank-session toolbar launcher can open the task panel immediately. For the recommended workflow, first send a short ordinary message to create a nonblank conversation, then select the regular **mobile_gui_agent** tab and enter the phone task there.

Built `lib/` artifacts are tracked so a pinned Git checkout can be installed without allowing a dependency build script:

```bash
dsh plugin --profile web add github:kunjinkao-os/dsh-mobile-gui-agent#v0.2.1
```

For an immutable review target, replace the release tag with its commit SHA. A release tarball can also be installed without a Git build step:

```bash
dsh plugin --profile web add ./dsh-mobile-gui-agent-0.2.1.tgz
```

Pin a reviewed tag or commit when installing a plugin that can control a real device.

## Wireless ADB

Pair the phone with the Android Platform Tools when the Android version requires pairing, then either connect before starting Harness:

```bash
adb connect DEVICE_IP:PORT
adb devices -l
```

or enter `DEVICE_IP:PORT` in the **mobile_gui_agent** panel and select **Connect**. The computer and Android device must be able to reach each other, and the wireless debugging port may change after Android restarts wireless debugging.

## Use

1. Open a Harness conversation and send a short initialization message, for example `Prepare a mobile task`.
2. Select the **mobile_gui_agent** conversation tab. The blank-session toolbar launcher remains available as an alternative.
3. Select a connected device and refresh the screenshot.
4. Enter the actual phone task in the **Task** field inside **mobile_gui_agent**, not in the ordinary Harness conversation composer. For example:

   ```text
   Open Settings and go to the Wi-Fi page
   ```

5. Select **Start**. Use **Pause**, **Resume**, or **Stop** when needed.
6. Answer approval prompts in the standard Harness approval UI. The Agent stops before the consequential action until approval is granted once.

Other example tasks:

```text
Open Android Settings
Open the browser and focus the address bar
Type hello world in the focused text field
Open WeChat, find File Transfer, and prepare to send “test123”
```

The last example requires approval before the semantic Send control is activated.

## Configuration

The bundle supplies safe defaults in [`cordis.patch.yml`](cordis.patch.yml). Override the complete plugin row in the profile's `cordis.patch.yml` because Harness patch rows replace, rather than deep-merge, their `config` value.

```yaml
- id: mobile-gui-agent
  name: dsh-mobile-gui-agent
  config:
    adb:
      adbPath: adb
      # unicodeImeApkPath: /absolute/path/to/reviewed/ADBKeyboard.apk
      commandTimeoutMs: 10000
      processGraceMs: 1000
      screenshotMaxBytes: 16777216
      hierarchyMaxBytes: 4194304
      diagnosticMaxBytes: 65536
      hierarchyMaxElements: 400
      hierarchyMaxSerializedBytes: 65536
      hierarchyAttempts: 3
      hierarchyRetryDelayMs: 300
      stablePollMs: 300
      stableSamples: 3
      stableTimeoutMs: 5000
      stableDifferenceThreshold: 0.01
    agent:
      maxSteps: 50
      taskTimeoutMs: 600000
      actionTimeoutMs: 30000
      maxConsecutiveFailures: 5
      stablePollMs: 300
      stableSamples: 3
      stableTimeoutMs: 5000
      stableDifferenceThreshold: 0.01
      approvalEnabled: true
      traceScreenshots: true
      maxTraceSteps: 100
```

`commandTimeoutMs` bounds one ADB subprocess. `actionTimeoutMs` bounds an entire action, including stabilization and the post-action observation. Keep `actionTimeoutMs` greater than `commandTimeoutMs`; slower wireless devices may need 30–60 seconds.

`unicodeImeApkPath` is optional and must be an absolute path on the Harness host. It is never accepted from the model. An already-installed helper is detected with Android's all-IME listing and used transparently: the plugin temporarily enables/selects it as needed, broadcasts the text, and restores the previous input method and enabled state. When the helper is absent and an APK path is configured, the Agent can call `setup_unicode_input`; Harness shows a mandatory one-shot approval before installation. Review the APK source and license before configuring it; the plugin does not bundle or download [ADBKeyBoard](https://github.com/senzhk/ADBKeyBoard).

`maxTraceSteps` bounds the live and terminal GUI step list. `maxSteps` and `taskTimeoutMs` bound a run. Screenshot and hierarchy byte limits prevent unbounded ADB output. Model-visible screenshots use the Harness attachment store when the selected model accepts images.

## Architecture

```text
dsh.bundle patch
└── dsh-mobile-gui-agent (one Cordis Loader row)
    ├── AdbPhoneDeviceRegistry       provides ctx.phone
    ├── PhoneAgentService            provides ctx.phoneRuns
    │   └── Agent-scoped tools       phone_observe + phone_act
    └── PhoneAgentRemote             Typert Host namespace

dsh.client browser contribution
├── mounts generated phoneAgent Typert Remote descriptors
├── registers the mobile_gui_agent conversation view
└── registers the blank-session mobile_gui_agent launcher
```

The existing Harness Agent owns planning and turn execution. Starting a Phone run installs only Agent-scoped Phone tools and the dedicated Phone system prompt. Each `phone_act` performs a fresh pre-action capture, validates the strict action, resolves semantic element bounds, requests approval if needed, executes through `PhoneDevice`, waits for a stable screen, captures again, verifies the result, and returns the new observation to the same Agent loop.

The compact hierarchy removes invisible and meaningless containers, prioritizes text and interactive nodes, assigns short IDs, and enforces element and serialized-byte limits. A `tap_element` action also carries the observation ID. Before execution, the plugin revalidates the selected element's resource ID, class, content description, and bounds; unrelated animation can continue, but a moved, missing, changed, or ambiguous target is rejected as stale.

## Model experience

Starting a run adds the dedicated Phone prompt and two Agent-scoped tools to the existing Harness Agent. `phone_observe` returns the foreground app, activity, compact hierarchy, screenshot attachment when supported, recent verified steps, and failure context. `phone_act` accepts one strict action and always returns a fresh post-action observation. The model never receives raw UIAutomator XML or arbitrary ADB shell access.

The prompt prefix is stable for a run, while each compact observation changes with the phone screen. Element and serialized-byte limits cap hierarchy growth; screenshot attachments are used only when the selected model accepts image input. Text-only models can still operate hierarchy-backed controls but cannot reliably reason about image-only UI without a `PhoneVisionProvider`.

## Security model

- The model cannot issue arbitrary ADB shell text. Provider-owned diagnostic commands use a closed `PhoneShellRequest` classification.
- Consequential semantic controls require the existing Harness approval service when `approvalEnabled` is true.
- Unicode helper setup always requires the Harness approval service, even when ordinary action approval is disabled.
- Approval is one-shot. A denied, unavailable, or cancelled approval becomes a structured action failure.
- Raw coordinate actions cannot always reveal their semantic effect. Review the visible target and use restrictive Harness permissions when operating accounts, payment apps, or sensitive data.
- Device actions are real. Use a test device and a non-production account during evaluation.

Report security issues according to [SECURITY.md](SECURITY.md).

## Known limitations

- UIAutomator can omit Canvas, game, image-only, and some WebView controls.
- Unicode text input requires a compatible external ADB Keyboard helper. Installed helpers are activated and restored transparently; installing a missing helper requires a reviewed APK at `adb.unicodeImeApkPath` and explicit approval.
- Wireless ADB latency and reliability depend on the network and the current Android debugging port.
- Raw-coordinate actions cannot always be classified by semantic impact; use semantic elements and review approval prompts.
- The MVP refreshes screenshots after observations and actions; it does not stream scrcpy video.

## Development

```bash
pnpm install
pnpm run typecheck
pnpm run build
pnpm run test
pnpm run verify:package
pnpm pack
```

The regular suite uses `FakePhoneDevice`. The real ADB integration suite automatically skips unless a device serial is supplied. Run its read-only screenshot and hierarchy check with:

```bash
DSH_PHONE_ADB_INTEGRATION_DEVICE=emulator-5554 pnpm run test:adb
```

Mutation checks are separately opt-in:

```bash
DSH_PHONE_ADB_INTEGRATION_DEVICE=emulator-5554 DSH_PHONE_ADB_MUTATION_TESTS=1 pnpm run test:adb
```

The mutation check can press Home, Back, tap, swipe, and enter text on the selected device. Use it only on a device where those actions are safe.

## Troubleshooting

### The `mobile_gui_agent` entry is missing

Confirm the plugin was added to the same Web profile you started, inspect `--dump-config`, and hard-refresh the browser after installation. A headless profile has no browser conversation views. On the empty new-conversation hero, the regular tab strip remains hidden by Harness, but the plugin's **mobile_gui_agent** button should appear in the composer toolbar after a workspace is selected; use it to open the task panel directly.

### `device unauthorized`

Unlock the phone, accept the RSA prompt, then run `adb kill-server`, `adb start-server`, and `adb devices -l`. Revoke USB debugging authorizations on Android if the prompt no longer appears.

### `exec-out screencap -p` timed out

Wireless ADB may be slow or disconnected. Run `adb -s DEVICE exec-out screencap -p > /tmp/phone.png` manually, reconnect the endpoint, keep the screen unlocked, and raise both `adb.commandTimeoutMs` and `agent.actionTimeoutMs`. The plugin reports the timeout as a recoverable action result instead of assuming the click succeeded.

### The hierarchy is empty or incomplete

UIAutomator does not expose every Canvas, WebView, game, or custom-rendered control. Use a vision-capable model, refresh the screenshot, scroll, close overlays, or provide a `PhoneVisionProvider` plugin.

### Text input is incorrect

ADB text input is most reliable with a focused ordinary text field. Printable ASCII uses Android's native `input text`. Unicode uses UTF-8 Base64 broadcasts through ADB Keyboard (`com.android.adbkeyboard/.AdbIME`). Check the current state with:

```bash
adb shell ime list -s
adb shell settings get secure enabled_input_methods
adb shell settings get secure default_input_method
```

The provider checks installation with `ime list -a -s`, rather than mistaking a disabled IME for an absent package. If ADB Keyboard is installed, `input_text` and `replace_text` temporarily enable/select it as needed and restore the exact previous IME state after the broadcast, including cancellation cleanup. If the helper is absent, set `adb.unicodeImeApkPath` to an absolute path for an APK you have reviewed. The Agent then calls `setup_unicode_input`, which cannot bypass Harness approval and installs only when necessary. If no path is configured, setup returns `PHONE_UNICODE_INPUT_UNSUPPORTED` and the Agent stops instead of retrying. `replace_text` updates a focused field in one verified step rather than repeatedly pressing Delete.

## License

[MIT](LICENSE)

The repository uses the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic so DSH community catalogs can discover it.
