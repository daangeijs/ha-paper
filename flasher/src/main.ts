// Page wiring. All decisions about what may be written live in flow.ts / writePlan.ts.
// Layout follows crosspoint's flash tool (eink-ha-os#239): connect, one install button, progress inline, extras under Advanced.

import { sha256Sidecar } from "./backup.ts";
import { startCarousel } from "./carousel.ts";
import { DEVICES, verifiedLine } from "./devices.ts";
import { type AppDesc, parseAppDesc, readInstalled } from "./firmwareInfo.ts";
import { type Progress, Session } from "./flow.ts";
import { ImprovClient, STATE } from "./improv.ts";
import type { Release } from "./release.ts";
import { type Connection, connect, reopenConsole, webSerialSupported } from "./serial.ts";
import { loadVersion, loadVersions, type VersionEntry, versionLabel } from "./versions.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const ui = {
  unsupported: $("unsupported"),
  release: $("release-status"),
  version: $<HTMLSelectElement>("version-select"),
  connect: $<HTMLButtonElement>("connect"),
  chip: $("chip-status"),
  connectError: $("connect-error"),
  devicePick: $("device-pick"),
  otherDevice: $("other-device"),
  deviceControls: $("device-controls"),
  deviceInfo: $("device-info"),
  wantBackup: $<HTMLInputElement>("want-backup"),
  install: $<HTMLButtonElement>("install"),
  backupTask: $("backup-task"),
  backupFiles: $("backup-files"),
  installTask: $("install-task"),
  restoreFile: $<HTMLInputElement>("restore-file"),
  restore: $<HTMLButtonElement>("restore"),
  wifiStep: $("wifi-step"),
  wifiStatus: $("wifi-status"),
  wifiForm: $<HTMLFormElement>("wifi-form"),
  wifiSsid: $<HTMLInputElement>("wifi-ssid"),
  wifiNetworks: $<HTMLDataListElement>("wifi-networks"),
  wifiPassword: $<HTMLInputElement>("wifi-password"),
  wifiJoin: $<HTMLButtonElement>("wifi-join"),
  wifiError: $("wifi-error"),
  log: $("log"),
  dialog: $<HTMLDialogElement>("confirm"),
  dialogTitle: $("confirm-title"),
  dialogBody: $("confirm-body"),
  dialogOk: $<HTMLButtonElement>("confirm-ok"),
};

let release: Release | null = null;
let versions: VersionEntry[] | null = null; // null: the single firmware/ layout
let releaseDesc: AppDesc | null = null; // the bundled firmware.bin's app descriptor, to recognise this build
let conn: Connection | null = null;
let session: Session | null = null;
let busy = false;
// The installed firmware's console, reopened after the reset for Improv Wi-Fi.
let improv: { port: SerialPort; client: ImprovClient } | null = null;

/** Where a step shows its progress and errors: inline, where the user clicked (eink-ha-os#239). */
interface StepUi {
  box?: HTMLElement;
  bar?: HTMLProgressElement;
  label?: HTMLElement;
  error: HTMLElement;
}

function stepUi(name: "backup" | "install" | "restore"): StepUi {
  return {
    box: $(`${name}-progress`),
    bar: $<HTMLProgressElement>(`${name}-bar`),
    label: $(`${name}-label`),
    error: $(`${name}-error`),
  };
}

const steps = {
  connect: { error: ui.connectError } as StepUi,
  wifi: { error: ui.wifiError } as StepUi,
  backup: stepUi("backup"),
  install: stepUi("install"),
  restore: stepUi("restore"),
};
let current: StepUi = steps.connect;

const DONE = "Done. Replug USB.";

function log(line: string) {
  ui.log.textContent += line;
  ui.log.scrollTop = ui.log.scrollHeight;
}

const terminal = {
  clean: () => {
    ui.log.textContent = "";
  },
  writeLine: (s: string) => log(s + "\n"),
  write: (s: string) => log(s),
};

function progressFor(step: StepUi, verb: string): Progress {
  return (_label, done, total) => {
    if (!step.box || !step.bar || !step.label) return;
    step.box.hidden = false;
    step.bar.max = total || 1;
    step.bar.value = done;
    const pct = total ? Math.floor((100 * done) / total) : 0;
    step.label.textContent = `${verb} ${pct}%`;
  };
}

function stepMessage(step: StepUi, text: string) {
  if (!step.box || !step.label) return;
  step.box.hidden = false;
  step.label.textContent = text;
}

type TaskState = "" | "running" | "done" | "failed";
function mark(li: HTMLElement, state: TaskState) {
  if (state) li.dataset.state = state;
  else delete li.dataset.state;
}

function setStatus(el: HTMLElement, text: string, kind: "ok" | "bad" | "" = "") {
  el.textContent = text;
  el.className = `${el.id === "chip-status" ? "status-inline" : "status"} ${kind}`;
}

function showError(e: unknown, hint = "") {
  const msg = e instanceof Error ? e.message : String(e);
  current.error.textContent = hint ? `${msg} ${hint}` : msg;
  terminal.writeLine("ERROR: " + msg);
}

function refresh() {
  const checked = session?.security != null;
  ui.connect.disabled = busy || !webSerialSupported();
  ui.connect.textContent = conn ? "Disconnect" : "Connect";
  ui.wantBackup.disabled = busy;
  ui.version.disabled = busy;
  ui.install.disabled = busy || !release || !session?.readyToInstall;
  ui.restore.disabled = busy || !checked || !ui.restoreFile.files?.length;
  ui.wifiJoin.disabled = busy || !improv;
}

async function run(step: StepUi, job: () => Promise<void>, hint = "") {
  busy = true;
  current = step;
  for (const s of Object.values(steps)) s.error.textContent = "";
  refresh();
  try {
    await job();
  } catch (e) {
    showError(e, hint);
  } finally {
    busy = false;
    refresh();
  }
}

function confirmWrite(title: string, body: HTMLElement, okLabel: string): Promise<boolean> {
  ui.dialogTitle.textContent = title;
  ui.dialogBody.replaceChildren(body);
  ui.dialogOk.textContent = okLabel;
  ui.dialog.returnValue = "";
  ui.dialog.showModal();
  return new Promise((resolve) => {
    ui.dialog.addEventListener("close", () => resolve(ui.dialog.returnValue === "ok"), { once: true });
  });
}

function el(tag: string, text = "", children: Node[] = []): HTMLElement {
  const e = document.createElement(tag);
  if (text) e.textContent = text;
  e.append(...children);
  return e;
}

function download(name: string, data: BlobPart, label: string): HTMLAnchorElement {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([data], { type: "application/octet-stream" }));
  a.download = name;
  a.textContent = label;
  return a;
}

async function disconnect() {
  ui.deviceInfo.textContent = "";
  await conn?.close().catch(() => {});
  conn = null;
  session = null;
}

async function finishWrite(step: StepUi, message: string) {
  stepMessage(step, message);
  // The chip resets after the write; the USB port goes away with it.
  await disconnect();
  setStatus(ui.chip, "Not connected");
}

async function closeImprov() {
  const i = improv;
  improv = null;
  ui.wifiForm.hidden = true;
  if (!i) return;
  await i.client.close();
  await i.port.close().catch(() => {});
}

const NO_IMPROV =
  "No answer over USB. Set up Wi-Fi on the display.";

function urlLinks(urls: string[]): Node[] {
  const nodes: Node[] = [];
  for (const [i, u] of urls.entries()) {
    if (i) nodes.push(document.createTextNode(" or "));
    const a = document.createElement("a");
    a.href = u;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = u;
    nodes.push(a);
  }
  return nodes;
}

// Step 4: after the reset, find the firmware on the same USB port. It answers Improv once its main loop runs (panel
// init and the first full refresh come first), so keep asking for ~10 s before falling back to the on-screen setup.
async function startWifiStep() {
  await closeImprov();
  setStatus(ui.wifiStatus, "Waiting for display…");
  // A minute: long enough for an unplug and replug when the reset after the write didn't restart it.
  const deadline = Date.now() + 60_000;
  let found: { state: number; urls: string[] } | null = null;
  while (!found && Date.now() < deadline) {
    const port = await reopenConsole(deadline - Date.now());
    if (!port) break;
    const client = new ImprovClient(port);
    client.start();
    found = await client.detect(Math.min(10_000, Math.max(0, deadline - Date.now())));
    if (found) {
      improv = { port, client };
      break;
    }
    await client.close();
    await port.close().catch(() => {});
    if (!client.ended) break; // the port works, the firmware just doesn't answer
  }
  if (!found || !improv) {
    setStatus(ui.wifiStatus, NO_IMPROV);
    return;
  }
  const info = await improv.client.info();
  if (info) terminal.writeLine(`Improv: ${info.join(" · ")}`);
  if (found.state === STATE.provisioned && found.urls.length) {
    ui.wifiStatus.replaceChildren(
      document.createTextNode("On Wi-Fi: "),
      ...urlLinks(found.urls),
      document.createTextNode(". To use another network, enter it below."),
    );
    ui.wifiStatus.className = "status ok";
  } else {
    setStatus(ui.wifiStatus, "Scanning networks…");
  }
  ui.wifiForm.hidden = false;
  refresh();
  const nets = await improv.client.scan();
  ui.wifiNetworks.replaceChildren(
    ...nets.map((n) => {
      const o = document.createElement("option");
      o.value = n.ssid;
      return o;
    }),
  );
  if (found.state !== STATE.provisioned) {
    setStatus(
      ui.wifiStatus,
      nets.length
        ? "Pick a network."
        : "Enter network and password (2.4 GHz).",
    );
  }
  if (!ui.wifiSsid.value && nets[0]) ui.wifiSsid.value = nets[0].ssid;
  ui.wifiSsid.focus();
}

ui.wifiForm.addEventListener("submit", (ev) => {
  ev.preventDefault();
  void run(steps.wifi, async () => {
    const client = improv?.client;
    if (!client) return;
    const ssid = ui.wifiSsid.value.trim();
    if (!ssid) throw new Error("Enter a network name.");
    setStatus(ui.wifiStatus, "Joining…");
    terminal.writeLine(`Improv: joining "${ssid}"`); // never the password
    try {
      const urls = await client.provision(ssid, ui.wifiPassword.value);
      ui.wifiPassword.value = "";
      await closeImprov();
      ui.wifiStatus.replaceChildren(
        document.createTextNode("Joined. Open "),
        ...urlLinks(urls),
        document.createTextNode(" on a phone or computer on the same Wi-Fi to sign in with Home Assistant."),
      );
      ui.wifiStatus.className = "status ok";
    } catch (e) {
      if (client.ended) {
        await closeImprov();
        setStatus(ui.wifiStatus, `USB connection lost. ${NO_IMPROV}`, "bad");
      } else {
        setStatus(ui.wifiStatus, e instanceof Error ? e.message : String(e), "bad");
      }
    }
  });
});


ui.connect.addEventListener("click", () =>
  run(steps.connect, async () => {
    await closeImprov();
    if (conn) {
      await disconnect();
      setStatus(ui.chip, "Not connected");
      return;
    }
    setStatus(ui.chip, "Connecting…");
    try {
      conn = await connect(terminal);
    } catch (e) {
      setStatus(ui.chip, "Not connected", "bad");
      if (e instanceof DOMException && e.name === "NotFoundError") throw new Error("No device picked.");
      throw e;
    }
    session = new Session(conn.loader, undefined, terminal.writeLine);
    setStatus(ui.chip, "Checking…");
    try {
      await session.chipCheck();
    } catch (e) {
      setStatus(ui.chip, "Not supported", "bad");
      await disconnect();
      throw e;
    }
    setStatus(ui.chip, "Connected", "ok");
    terminal.writeLine(`${conn.description}: no secure boot, no flash encryption.`);
    await showDevice(conn);
  }, "Replug USB and retry."),
);

// Chip, flash, MAC and what is installed, read-only (a few KB). A failure here only hides the line.
async function showDevice(c: Connection) {
  const size = (await c.loader.detectFlashSize().catch(() => undefined)) ?? "?";
  const mac = c.mac ? ` · …${c.mac.slice(-8)}` : "";
  ui.deviceInfo.textContent = `ESP32-S3 · ${size.replace("MB", " MB")}${mac}`;
  try {
    const found = await readInstalled(c.loader, release ? { desc: releaseDesc, version: release.manifest.version } : undefined);
    ui.deviceInfo.textContent += ` · ${found.label}`;
    if (found.desc) terminal.writeLine(`Installed (${found.slot}): ${found.desc.project} ${found.desc.version}, ${found.desc.date}`);
  } catch (e) {
    terminal.writeLine(`Could not read the installed firmware: ${e instanceof Error ? e.message : e}`);
  }
}

function showVerified(version?: string) {
  for (const d of DEVICES) {
    const el = document.getElementById(`${d.id}-verified`);
    const text = el?.querySelector(".text");
    const line = verifiedLine(d, version);
    if (!el || !text) continue;
    text.textContent = line;
    el.hidden = !line;
  }
}

function pickDevice() {
  const supported = ui.devicePick.querySelector<HTMLInputElement>("input:checked")?.value === "x4pro";
  ui.deviceControls.hidden = !supported;
  ui.otherDevice.hidden = supported;
}
ui.devicePick.addEventListener("change", pickDevice);

ui.install.addEventListener("click", () =>
  run(steps.install, async () => {
    if (!session || !release) return;
    const s = session;
    const backupFirst = ui.wantBackup.checked && !s.backup;
    // Ask before anything runs; offsets live under Technical details (eink-ha-os#183).
    const body = el("div", "", [
      el("p", "Replaces the current firmware. Wi-Fi and settings stay."),
      ...(backupFirst ? [el("p", "Backup first.")] : []),
    ]);
    if (!(await confirmWrite(`Install HA Paper ${release.manifest.version}?`, body, "Install"))) return;
    ui.installTask.hidden = false;
    mark(ui.installTask, "");
    if (backupFirst) {
      ui.backupTask.hidden = false;
      mark(ui.backupTask, "running");
      current = steps.backup;
      try {
        const b = await s.makeBackup(progressFor(steps.backup, "Reading…"));
        const bin = download(b.name, b.data as Uint8Array<ArrayBuffer>, b.name);
        ui.backupFiles.replaceChildren(
          bin,
          document.createTextNode(" · "),
          download(b.name + ".sha256", sha256Sidecar(b.name, b.sha256), ".sha256"),
        );
        bin.click(); // save right away so it isn't lost if the tab closes
        if (!b.looksValid) throw new Error("Backup is not a valid flash image.");
        stepMessage(steps.backup, "Saved");
        mark(ui.backupTask, "done");
      } catch (e) {
        mark(ui.backupTask, "failed");
        throw e;
      }
    }
    current = steps.install;
    mark(ui.installTask, "running");
    try {
      await s.install(release, progressFor(steps.install, "Writing…"));
    } catch (e) {
      mark(ui.installTask, "failed");
      throw e;
    }
    mark(ui.installTask, "done");
    await finishWrite(steps.install, DONE);
    ui.wifiStep.hidden = false;
    await startWifiStep().catch(() => setStatus(ui.wifiStatus, NO_IMPROV));
  }, "Reconnect and retry."),
);

ui.restoreFile.addEventListener("change", refresh);

ui.restore.addEventListener("click", () =>
  run(steps.restore, async () => {
    if (!session) return;
    const files = [...(ui.restoreFile.files ?? [])];
    const bin = files.find((f) => !f.name.endsWith(".sha256"));
    const side = files.find((f) => f.name.endsWith(".sha256"));
    if (!bin) throw new Error("Pick a .bin file.");
    const data = new Uint8Array(await bin.arrayBuffer());
    const expected = side ? (await side.text()).trim().split(/\s+/)[0] : undefined;
    const body = el("div", "", [
      el("p", `Overwrites all flash with ${bin.name}.`),
      el("p", side ? `Verified with ${side.name}.` : "No .sha256: size check only."),
    ]);
    if (!(await confirmWrite("Restore backup?", body, "Restore"))) return;
    await session.restore(bin.name, data, expected, progressFor(steps.restore, "Writing…"));
    await finishWrite(steps.restore, DONE);
  }),
);

// Load the chosen version's files. Every release is tested on a real X4 Pro before it ships, so the badge shows
// only for the latest one (eink-ha-os#239).
async function selectVersion(i: number) {
  release = null;
  releaseDesc = null;
  showVerified();
  refresh();
  try {
    const r = await loadVersion((u) => fetch(u), versions ? versions[i] : null);
    release = r;
    releaseDesc = parseAppDesc(r.files.get("firmware.bin") ?? new Uint8Array());
    if (!versions) {
      const only = { version: r.manifest.version, prerelease: r.manifest.version.includes("-"), date: "", path: "firmware/" };
      ui.version.replaceChildren(new Option(versionLabel(only, true), "0"));
    }
    if (i === 0) showVerified(r.manifest.version);
    setStatus(ui.release, "");
  } catch (e) {
    setStatus(ui.release, `Firmware files invalid: ${e instanceof Error ? e.message : e}`, "bad");
  }
  refresh();
}

ui.version.addEventListener("change", () => void selectVersion(Number(ui.version.value)));

async function init() {
  startCarousel($("carousel"));
  showVerified();
  pickDevice();
  if (!webSerialSupported() || !window.isSecureContext) {
    ui.unsupported.hidden = false;
  }
  refresh();
  try {
    versions = await loadVersions((u) => fetch(u));
  } catch (e) {
    setStatus(ui.release, `${e instanceof Error ? e.message : e}`, "bad"); // a broken list: fall back to firmware/
  }
  if (versions) ui.version.replaceChildren(...versions.map((v, i) => new Option(versionLabel(v, i === 0), String(i))));
  await selectVersion(0);
}

void init();
