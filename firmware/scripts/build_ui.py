# PlatformIO pre-script: package the device web console into the `www` LittleFS image (www.bin, partition `www`).
#
#   emulator/  `npm run build:device-ui`  →  emulator/dist-device-ui/{index.html,app.js,app.css,…}
#   →  firmware/data/www/<file>.gz   (ESPAsyncWebServer serves the .gz with Content-Encoding: gzip)
#   spec/openapi.yaml  →  firmware/data/www/openapi.yaml.gz  (GET /openapi.yaml, no auth)
#   $X4_FW_VERSION     →  firmware/data/www/version.txt  (plain; the firmware compares it to its own, #350)
#
# Runs only for `pio run -t buildfs|uploadfs` (or with X4_BUILD_UI=1) so normal firmware builds stay fast.
# If node/npm or the emulator sources are missing, the image ships without /www and the firmware serves its
# built-in fallback setup page (src/net/web_fallback.h).
import csv
import gzip
import inspect
import os
import shutil
import subprocess
import sys

Import("env")  # noqa: F821  (PlatformIO SCons global)

# buildfs writes $BUILD_DIR/www.bin (default would be littlefs.bin): the release asset is named after its partition.
env.Replace(ESP32_FS_IMAGE_NAME="www")  # noqa: F821

FW_DIR = env.subst("$PROJECT_DIR")  # noqa: F821
ROOT = os.path.abspath(os.path.join(FW_DIR, ".."))
EMU = os.path.join(ROOT, "emulator")
DIST = os.path.join(EMU, "dist-device-ui")
WWW = os.path.join(FW_DIR, "data", "www")
# SCons does not reliably set __file__ for extra scripts; take this script's path from the running frame.
SCRIPT_DIR = os.path.dirname(os.path.abspath(inspect.getframeinfo(inspect.currentframe()).filename))
PARTITIONS = os.path.join(SCRIPT_DIR, "..", "partitions.csv")


def log(msg):
    print("[build_ui] " + msg)


def www_partition_size():
    with open(PARTITIONS) as f:
        for row in csv.reader(line for line in f if not line.lstrip().startswith("#")):
            if row and row[0].strip() == "www":
                return int(row[4].strip(), 0)
    raise RuntimeError("no `www` partition in " + PARTITIONS)


def too_big(n):
    limit = www_partition_size()
    if n > limit:
        log("ERROR: www.bin is %d bytes, partition www is %d" % (n, limit))
        return True
    return False


def check_image(target, source, env):
    return 1 if too_big(os.path.getsize(str(target[0]))) else 0


def npm_build():
    if not os.path.isfile(os.path.join(EMU, "package.json")):
        log("emulator/ not found — skipping web console build")
        return False
    npm = shutil.which("npm")
    if not npm:
        log("npm not on PATH — using existing dist-device-ui (if any)")
        return os.path.isdir(DIST)
    try:
        if not os.path.isdir(os.path.join(EMU, "node_modules")):
            subprocess.check_call([npm, "ci"], cwd=EMU)
        subprocess.check_call([npm, "run", "build:device-ui"], cwd=EMU)
        return True
    except subprocess.CalledProcessError as e:
        log("npm run build:device-ui failed (%s) — using existing dist-device-ui (if any)" % e)
        return os.path.isdir(DIST)


def package():
    if os.path.isdir(WWW):
        shutil.rmtree(WWW)
    os.makedirs(WWW, exist_ok=True)
    if not os.path.isdir(DIST):
        open(os.path.join(WWW, ".fallback"), "w").write("no device UI built; firmware serves its fallback page\n")
        log("no emulator/dist-device-ui — www.bin gets no /www (fallback page in firmware)")
        return
    total = 0
    for base, _, files in os.walk(DIST):
        for f in files:
            src = os.path.join(base, f)
            rel = os.path.relpath(src, DIST)
            dst = os.path.join(WWW, rel + ".gz")
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            with open(src, "rb") as i, gzip.GzipFile(dst, "wb", compresslevel=9, mtime=0) as o:
                o.write(i.read())
            total += os.path.getsize(dst)
    # The console's version (#350): the firmware compares it to its own (net/www_ota.h); same default as net/util.cpp
    version = os.environ.get("X4_FW_VERSION") or "0.0.0-dev"
    with open(os.path.join(WWW, "version.txt"), "w") as o:
        o.write(version + "\n")
    spec = os.path.join(ROOT, "spec", "openapi.yaml")
    if os.path.isfile(spec):
        dst = os.path.join(WWW, "openapi.yaml.gz")
        with open(spec, "rb") as i, gzip.GzipFile(dst, "wb", compresslevel=9, mtime=0) as o:
            o.write(i.read())
        total += os.path.getsize(dst)
    log("packaged %s + spec/openapi.yaml + version.txt (%s) → data/www (%d KB gzipped)" % (os.path.relpath(DIST, ROOT), version, total // 1024))
    if too_big(total):
        sys.exit(1)


targets = [str(t) for t in COMMAND_LINE_TARGETS]  # noqa: F821
if "buildfs" in targets or "uploadfs" in targets or os.environ.get("X4_BUILD_UI") == "1":
    if os.environ.get("X4_SKIP_NPM") != "1":
        npm_build()
    package()
    env.AddPostAction("$BUILD_DIR/${ESP32_FS_IMAGE_NAME}.bin", check_image)  # noqa: F821
