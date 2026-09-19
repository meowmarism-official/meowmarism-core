// Guards for deleting an instance folder: returns an error string, or null when the folder may be deleted.
const fs = require('fs');
const path = require('path');

function checkDeletableDir(dir, installDir, homeDir) {
  const target = path.resolve(dir);
  const root = path.parse(target).root;
  if (target === root || target === path.resolve(homeDir) || target === path.dirname(path.resolve(homeDir))) return 'this folder is too important to delete from here';
  if (target.split(path.sep).filter(Boolean).length < 3) return 'this folder is too close to the disk root to delete from here';
  const install = path.resolve(installDir);
  if (install === target || install.startsWith(target + path.sep)) return 'this instance folder also contains the panel itself, so it cannot be deleted from the panel';
  if (target.startsWith(install + path.sep)) return 'this folder is inside the panel installation';
  if (!['server.properties', 'eula.txt', 'run.sh', 'server.jar'].some((f) => fs.existsSync(path.join(target, f)))) return 'this does not look like a Minecraft server folder, nothing was deleted';
  return null;
}

module.exports = { checkDeletableDir };
