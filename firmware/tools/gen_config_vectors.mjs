// Generates firmware/test/vectors/config.json (parser edge cases) by running the TypeScript reference parser
// (emulator/src/core/config.ts) in Node. spec/test-vectors/config/ (emulator `npm run vectors`) covers the rules.
// Usage (from firmware/, Node ≥ 22.18 for .ts imports): node tools/gen_config_vectors.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseYaml, toYaml } from '../../emulator/src/core/config.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

const def = fs.readFileSync(path.join(here, '../../spec/default-screens.yaml'), 'utf8');
const S = (body) => 'version: 1\nscreens:\n' + body;
const one = (w, extra = '') => S('  - id: a\n    title: A\n' + extra + '    widgets:\n' + w.map((x) => '      - ' + x + '\n').join(''));
const cases = [
  ['default', def],
  ['empty', ''],
  ['comments only', '# nothing\n\n   # more\n'],
  ['version 2', 'version: 2\nscreens:\n  - id: a\n'],
  ['version 01', 'version: 01\n'],
  ['id before screens', 'version: 1\n  - id: a\n'],
  ['app before any screen', 'screens:\n    app: home\n'],
  ['widgets before any screen', 'screens:\n    widgets:\n'],
  ['unknown app', S('  - id: a\n    app: garden\n')],
  ['widget outside widgets', S('  - id: a\n      - {type: clock}\n')],
  ['unknown type', one(['{type: radar}'])],
  ['missing type', one(['{cs: 2}'])],
  ['numeric type', one(['{type: 5}'])],
  ['any sensor entity', one(['{type: stat, entity: sensor.nope}'])],
  ['stat wrong domain', one(['{type: stat, entity: light.nope}'])],
  ['stat without entity', one(['{type: stat}'])],
  ['unknown route', one(['{type: route, route: bus99}'])],
  ['cs 5', one(['{type: clock, cs: 5}'])],
  ['cs 0 accepted', one(['{type: clock, cs: 0}'])],
  ['cs empty accepted', one(['{type: clock, cs: }'])],
  ['cs text', one(['{type: clock, cs: two}'])],
  ['cs leading zero', one(['{type: clock, cs: 02}'])],
  ['rs 3', one(['{type: clock, rs: 3}'])],
  ['rs 2 ok', one(['{type: thermo, zone: living, rs: 2}'])],
  ['expected key value', one(['{type clock}'])],
  ['empty braces', one(['{}'])],
  ['trailing comma', one(['{type: clock,}'])],
  ['value with colon', one(['{type: setting, key: a:b}'])],
  ['index-like keys first', one(['{zz: 1, 2: x, type: clock, 0: y}'])],
  ['duplicate keys', one(['{type: clock, cs: 2, cs: 1}'])],
  ['too many cells', one(['{type: clock, cs: 4}', '{type: bars, series: prices, cs: 4}', '{type: price}'])],
  ['too many cells quoted title', S('  - id: a\n    title: "Big: one"\n    widgets:\n      - {type: lightList, cs: 4, rs: 2}\n      - {type: gauge}\n')],
  ['exactly 8 cells', one(['{type: lightList, cs: 4, rs: 2}'])],
  ['duplicate id', S('  - id: a\n    widgets: []\n  - id: b\n    widgets: []\n  - id: a\n    widgets: []\n')],
  ['malformed line', S('  - id: a\n    colour: red\n')],
  ['bad indent', S(' - id: a\n')],
  ['empty widgets list', S('  - id: a\n    title: Empty\n    widgets: []\n')],
  ['quoted title escapes', S('  - id: a\n    title: "Say \\"hi\\" \\u00e9"\n    widgets: []\n')],
  ['broken quoted title', S('  - id: a\n    title: "unterminated\n    widgets: []\n')],
  ['title needs quoting', S('  - id: a\n    title: Prices, today\n    widgets: []\n')],
  ['title spaces only', S('  - id: a\n    title:   \n    widgets: []\n')],
  ['title missing value', S('  - id: a\n    title:\n')],
  ['title unicode', S('  - id: a\n    title: Attic · Ŝ → €\n    widgets: []\n')],
  ['crlf', 'version: 1\r\nscreens:\r\n  - id: a\r\n    title: A\r\n    widgets: []\r\n'],
  ['crlf no title', 'version: 1\r\nscreens:\r\n  - id: a\r\n    widgets:\r\n      - {type: clock}\r\n'],
  ['tabs and trailing spaces', 'version: 1   \nscreens:\t\n  - id: a  \n    widgets:   \n      - {type: clock}   \n'],
  ['screens twice', S('  - id: a\n    widgets: []\nscreens:\n  - id: b\n    widgets: []\n')],
  ['screens reset orphan widgets', S('  - id: a\n    widgets:\nscreens:\n      - {type: clock}\n  - id: b\n    widgets: []\n')],
  ['no screens', 'version: 1\nscreens:\n'],
  ['id with spaces', S('  - id: a b\n')],
  ['all widget types', S('  - id: a\n    widgets:\n      - {type: clock}\n      - {type: stat, entity: sensor.grid_power}\n      - {type: price}\n      - {type: gauge}\n      - {type: bars, series: usage}\n      - {type: switch, entity: switch.x}\n      - {type: scene, scene: all_off}\n      - {type: setting, key: night}\n  - id: b\n    widgets:\n      - {type: route, route: car, cs: 2}\n      - {type: thermo, zone: hall}\n      - {type: ota}\n      - {type: wifi}\n      - {type: ha}\n      - {type: about}\n  - id: c\n    app: house\n    widgets:\n      - {type: zoneList}\n      - {type: lightList}\n')],
  ['app settings and travel', S('  - id: a\n    app: settings\n  - id: b\n    app: travel\n    title: "Trips"\n    widgets: []\n')],
  ['quoted app', S('  - id: a\n    app: "house"\n    widgets: []\n')],
  ['comment between', S('  - id: a\n    # comment\n    widgets:\n      # inner\n      - {type: clock}\n')],
  ['widget extra spaces inside', one(['{ type :  clock ,  cs : 2 }'])],
  ['widget text after brace', one(['{type: clock} x'])],
  ['brace inside value', one(['{type: setting, key: {x}}'])],
  ['legacy light', one(['{type: light, light: x, cs: 2}'])],
  ['custom apps', 'version: 1\napps:\n  - id: a\n    title: "A, b"\nscreens:\n  - id: s\n    widgets: []\n'],
];

const out = cases.map(([name, yaml]) => {
  try {
    const cfg = parseYaml(yaml);
    return { name, yaml, ok: true, line: 0, message: '', screens: cfg.screens.length, toYaml: toYaml(cfg) };
  } catch (e) {
    if (e && e.line !== undefined) return { name, yaml, ok: false, line: e.line, message: e.msg };
    throw e;
  }
});
const dst = path.join(here, '../test/vectors/config.json');
fs.mkdirSync(path.dirname(dst), { recursive: true });
fs.writeFileSync(dst, JSON.stringify(out, null, 1) + '\n');
console.log('wrote', dst, out.length, 'cases,', out.filter((c) => c.ok).length, 'ok');
