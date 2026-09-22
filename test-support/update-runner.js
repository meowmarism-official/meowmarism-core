// Runs the real updater in its own process: node update-runner.js <update|boot>
// Env: INSTALL_DIR (folder with package.json and panel/), HOOK_LOG (file that records stop/restore),
//      FAULT_AT (make the n-th file operation on the install folder fail), OPS_FILE (where the number of operations is written).
const fs = require('fs');
const path = require('path');

const installDir = path.resolve(process.env.INSTALL_DIR);
const faultAt = Number(process.env.FAULT_AT) || 0;
let ops = 0;

// Every file operation that touches the install folder or the updater's state files is counted, and the chosen one fails.
const touches = (arg) => typeof arg === 'string' && (path.resolve(arg).startsWith(installDir + path.sep) || path.basename(arg).startsWith('.meowmarism-test-'));
for (const name of ['cpSync', 'renameSync', 'copyFileSync', 'rmSync', 'writeFileSync', 'unlinkSync']) {
  const original = fs[name];
  fs[name] = function patched(...args) {
    if (touches(args[0]) || touches(args[1])) {
      ops += 1;
      if (faultAt && ops === faultAt) throw new Error(`injected fault at operation ${ops} (${name})`);
    }
    return original.apply(this, args);
  };
}
process.on('exit', () => { if (process.env.OPS_FILE) original_write(process.env.OPS_FILE, String(ops)); });
const original_write = fs.writeFileSync.bind(fs);

const { createUpdater } = require('../modules/updater');
const log = (line) => fs.appendFileSync(process.env.HOOK_LOG, line + '\n');
const updater = createUpdater({
  repo: 'test/repo',
  panelDir: path.join(installDir, 'panel'),
  statePrefix: '.meowmarism-test',
  probePath: '/',
  hooks: { stop: async () => { log('stop'); return 'token-1'; }, restore: (token) => log(`restore:${token}`) },
});

const mode = process.argv[2];
(async () => {
  if (mode === 'boot') {
    updater.bootCheck();
    updater.confirmHealthy();
    await new Promise((resolve) => setTimeout(resolve, Number(process.env.WAIT_MS) || 800));
    process.exit(0);
  }
  const kind = process.env.UPDATE_KIND || undefined;
  const first = updater.start(kind);
  const second = updater.start(kind);
  console.log(JSON.stringify({ started: first, second }));
  for (let i = 0; i < 400; i++) {
    const s = updater.status();
    if (!s.running) { console.log(JSON.stringify({ error: s.error, step: s.step })); process.exit(0); }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  console.log(JSON.stringify({ error: 'the update did not finish' }));
  process.exit(0);
})();
