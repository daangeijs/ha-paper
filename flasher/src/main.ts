// Page wiring. All decisions about what may be written live in flow.ts / writePlan.ts.

import { sha256Sidecar } from "./backup.ts";
import { type Backup, type Progress, Session } from "./flow.ts";
import { ImprovClient, STATE } from "./improv.ts";
import { loadRelease, type Release } from "./release.ts";
import { type Connection, connect, reopenConsole, webSerialSupported } from "./serial.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const ui = {
  unsupported: $("unsupported"),
  release: $("release-status"),
  connect: $<HTMLButtonElement>("connect"),
  chip: $("chip-status"),
  backup: $<HTMLButtonElement>("backup"),
  backupResult: $("backup-result"),
  skip: $<HTMLInputElement>("skip-backup"),
  install: $<HTMLButtonElement>("install"),
  restoreFile: $<HTMLInputElement>("restore-file"),
  restore: $<HTMLButtonElement>("restore"),
  wifiStatus: $("wifi-status"),
  wifiForm: $<HTMLFormElement>("wifi-form"),
  wifiSsid: $<HTMLInputElement>("wifi-ssid"),
  wifiNetworks: $<HTMLDataListElement>("wifi-networks"),
  wifiPassword: $<HTMLInputElement>("wifi-password"),
  wifiJoin: $<HTMLButtonElement>("wifi-join"),
  progress: $<HTMLProgressElement>("progress"),
  progressLabel: $("progress-label"),
  error: $("error"),
  log: $("log"),
  dialog: $<HTMLDialogElement>("confirm"),
  dialogTitle: $("confirm-title"),
  dialogBody: $("confirm-body"),
  dialogOk: $<HTMLButtonElement>("confirm-ok"),
};

let release: Release | null = null;
let conn: Connection | null = null;
let session: Session | null = null;
let busy = false;
// The installed firmware's console, reopened after the reset for Improv Wi-Fi (step 4).
let improv: { port: SerialPort; client: ImprovClient } | null = null;

const DOWNLOAD_MODE = "Put the display in download mode (hold Left, press Reset, release Left) and click Connect again.";

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

const progress: Progress = (label, done, total) => {
  ui.progress.max = total || 1;
  ui.progress.value = done;
  const pct = total ? Math.floor((100 * done) / total) : 0;
  ui.progressLabel.textContent = `${label}: ${pct}%`;
};

function setStatus(el: HTMLElement, text: string, kind: "ok" | "bad" | "" = "") {
  el.textContent = text;
  el.className = "status " + kind;
}

function showError(e: unknown, hint = "") {
  const msg = e instanceof Error ? e.message : String(e);
  ui.error.textContent = hint ? `${msg} ${hint}` : msg;
  terminal.writeLine("ERROR: " + msg);
}

function refresh() {
  const checked = session?.security != null;
  ui.connect.disabled = busy || !webSerialSupported();
  ui.backup.disabled = busy || !checked || session?.backup != null;
  ui.skip.disabled = busy || !checked || session?.backup != null;
  ui.install.disabled = busy || !release || !session?.readyToInstall;
  ui.restore.disabled = busy || !checked || !ui.restoreFile.files?.length;
  ui.wifiJoin.disabled = busy || !improv;
}

async function run(task: () => Promise<void>, hint = "") {
  busy = true;
  ui.error.textContent = "";
  refresh();
  try {
    await task();
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

async function finishWrite(message: string) {
  setStatus(ui.chip, message, "ok");
  ui.progressLabel.textContent = message;
  // The chip resets after the write; the USB port goes away with it.
  await conn?.close().catch(() => {});
  conn = null;
  session = null;
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
  "The display did not answer over USB. Unplug the cable and set up Wi-Fi on the display: pick your network on the " +
  "screen, or tap Set up from phone and join the HA-Paper-Setup Wi-Fi with your phone.";

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
  setStatus(ui.wifiStatus, "Waiting for the display to start…");
  const deadline = Date.now() + 20_000;
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
      document.createTextNode("The display is already on Wi-Fi: "),
      ...urlLinks(found.urls),
      document.createTextNode(". To use another network, enter it below."),
    );
    ui.wifiStatus.className = "status ok";
  } else {
    setStatus(ui.wifiStatus, "The display is listening. Looking for networks…");
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
        ? `The display sees ${nets.length} network${nets.length === 1 ? "" : "s"}. Pick yours and type its password.`
        : "Type your network name and password. Only 2.4 GHz networks work.",
    );
  }
  if (!ui.wifiSsid.value && nets[0]) ui.wifiSsid.value = nets[0].ssid;
  ui.wifiSsid.focus();
}

ui.wifiForm.addEventListener("submit", (ev) => {
  ev.preventDefault();
  void run(async () => {
    const client = improv?.client;
    if (!client) return;
    const ssid = ui.wifiSsid.value.trim();
    if (!ssid) throw new Error("Type the network name.");
    setStatus(ui.wifiStatus, `Joining "${ssid}"… (up to half a minute)`);
    terminal.writeLine(`Improv: joining "${ssid}"`); // never the password
    try {
      const urls = await client.provision(ssid, ui.wifiPassword.value);
      ui.wifiPassword.value = "";
      await closeImprov();
      ui.wifiStatus.replaceChildren(
        document.createTextNode(`Joined "${ssid}". You can unplug the cable. Open `),
        ...urlLinks(urls),
        document.createTextNode(" on a phone or computer on the same Wi-Fi to sign in with Home Assistant."),
      );
      ui.wifiStatus.className = "status ok";
    } catch (e) {
      if (client.ended) {
        await closeImprov();
        setStatus(ui.wifiStatus, `The USB connection to the display was lost. ${NO_IMPROV}`, "bad");
      } else {
        setStatus(ui.wifiStatus, e instanceof Error ? e.message : String(e), "bad");
      }
    }
  });
});

ui.connect.addEventListener("click", () =>
  run(async () => {
    await closeImprov();
    await conn?.close().catch(() => {});
    conn = null;
    session = null;
    setStatus(ui.chip, "Connecting…");
    try {
      conn = await connect(terminal);
    } catch (e) {
      setStatus(ui.chip, "Not connected.", "bad");
      if (e instanceof DOMException && e.name === "NotFoundError") throw new Error("No device picked.");
      throw e;
    }
    session = new Session(conn.loader, undefined, terminal.writeLine);
    setStatus(ui.chip, `Connected: ${conn.description}. Checking eFuses…`);
    try {
      await session.chipCheck();
    } catch (e) {
      setStatus(ui.chip, "Chip check failed. Nothing was written.", "bad");
      throw e;
    }
    setStatus(ui.chip, `${conn.description}: no secure boot, no flash encryption.`, "ok");
  }, DOWNLOAD_MODE),
);

ui.backup.addEventListener("click", () =>
  run(async () => {
    if (!session) return;
    const b: Backup = await session.makeBackup(progress);
    const kb = el("p", "", [
      download(b.name, b.data as Uint8Array<ArrayBuffer>, `Save ${b.name}`),
      document.createTextNode(" · "),
      download(b.name + ".sha256", sha256Sidecar(b.name, b.sha256), "Save .sha256"),
    ]);
    const parts = [
      el("p", "Backup read: 16 MB. Save both files now; the page does not keep them.", []),
      kb,
      el("p", "", [el("code", "SHA-256 " + b.sha256)]),
    ];
    if (!b.looksValid) {
      parts.push(el("p", "Warning: the backup does not start with an ESP32 bootloader header. Read it again before installing."));
    }
    ui.backupResult.replaceChildren(...parts);
    ui.backupResult.className = "status " + (b.looksValid ? "ok" : "bad");
    // Download the image right away so it isn't lost if the tab closes.
    (kb.firstChild as HTMLAnchorElement).click();
  }),
);

ui.skip.addEventListener("change", () => {
  if (ui.skip.checked) session?.skipBackup();
  else if (session) session.backupSkipped = false;
  refresh();
});

ui.install.addEventListener("click", () =>
  run(async () => {
    if (!session || !release) return;
    // offsets live under Technical details (#183)
    const body = el("div", "", [
      el("p", `Write HA Paper ${release.manifest.version} to this display? It replaces the firmware on it.`),
      el("p", "Saved Wi-Fi, your screens and the factory panel settings stay. Don't unplug the cable until it says done."),
    ]);
    if (!(await confirmWrite("Install HA Paper", body, "Write"))) return;
    await session.install(release, progress);
    await finishWrite(`HA Paper ${release.manifest.version} written. The display restarts; press Reset if it doesn't.`);
    await startWifiStep().catch(() => setStatus(ui.wifiStatus, NO_IMPROV));
  }, "If it stopped halfway, reconnect in download mode and install again, or restore your backup."),
);

ui.restoreFile.addEventListener("change", refresh);

ui.restore.addEventListener("click", () =>
  run(async () => {
    if (!session) return;
    const files = [...(ui.restoreFile.files ?? [])];
    const bin = files.find((f) => !f.name.endsWith(".sha256"));
    const side = files.find((f) => f.name.endsWith(".sha256"));
    if (!bin) throw new Error("Pick the backup .bin file.");
    const data = new Uint8Array(await bin.arrayBuffer());
    const expected = side ? (await side.text()).trim().split(/\s+/)[0] : undefined;
    const body = el("div", "", [
      el("p", `Write ${bin.name} (${data.length} bytes) over the whole flash at 0x0? This replaces HA Paper.`),
      el("p", side ? `Checked against ${side.name} first.` : "No .sha256 file picked: only the size is checked."),
    ]);
    if (!(await confirmWrite("Restore backup", body, "Restore"))) return;
    await session.restore(bin.name, data, expected, progress);
    await finishWrite("Backup restored. Press Reset.");
  }),
);

async function init() {
  if (!webSerialSupported() || !window.isSecureContext) {
    ui.unsupported.hidden = false;
  }
  refresh();
  try {
    release = await loadRelease((u) => fetch(u));
    setStatus(ui.release, `HA Paper ${release.manifest.version}. Files match SHA256SUMS and manifest.json.`, "ok");
  } catch (e) {
    setStatus(ui.release, `Firmware files not usable: ${e instanceof Error ? e.message : e} Installing is off.`, "bad");
  }
  refresh();
}

void init();
