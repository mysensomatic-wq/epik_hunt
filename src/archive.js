'use strict';

const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const chalk = require('chalk');

/**
 * Recursively sum all file sizes in a directory (in bytes).
 * @param {string} dir
 * @returns {number}
 */
function dirSizeBytes(dir) {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += dirSizeBytes(full);
    } else {
      total += fs.statSync(full).size;
    }
  }
  return total;
}

/**
 * Collect all date-folder names (YYYY-MM-DD) directly under snapshotsDir.
 * @param {string} snapshotsDir
 * @returns {string[]} sorted ascending
 */
function getDateFolders(snapshotsDir) {
  if (!fs.existsSync(snapshotsDir)) return [];
  return fs
    .readdirSync(snapshotsDir, { withFileTypes: true })
    .filter(e => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
    .map(e => e.name)
    .sort();
}

/**
 * Create a zip archive of snapshotsDir into archivePath using archiver.
 * @param {string} snapshotsDir
 * @param {string} archivePath
 * @returns {Promise<void>}
 */
function zipDirectory(snapshotsDir, archivePath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(archivePath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', resolve);
    archive.on('error', reject);

    archive.pipe(output);
    archive.directory(snapshotsDir, false);
    archive.finalize();
  });
}

/**
 * Delete all date-subfolders inside snapshotsDir but keep the folder itself.
 * @param {string} snapshotsDir
 * @param {string[]} dateFolders
 */
function clearDateFolders(snapshotsDir, dateFolders) {
  for (const date of dateFolders) {
    const dir = path.join(snapshotsDir, date);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Check total snapshot size and rotate if it exceeds the threshold.
 *
 * @param {object} config
 * @returns {Promise<{rotated: boolean, size_mb: number, archive_path: string|null}>}
 */
async function checkAndRotate(config) {
  const snapshotsDir = config.snapshots_dir;
  const archivesDir = config.archives_dir;
  const thresholdMb = config.archive_threshold_mb;

  const sizeBytes = dirSizeBytes(snapshotsDir);
  const sizeMb = sizeBytes / (1024 * 1024);

  if (sizeMb <= thresholdMb) {
    return { rotated: false, size_mb: parseFloat(sizeMb.toFixed(3)), archive_path: null };
  }

  // Determine date range from subfolder names
  const dateFolders = getDateFolders(snapshotsDir);
  const oldest = dateFolders[0] || 'unknown';
  const newest = dateFolders[dateFolders.length - 1] || 'unknown';

  // Ensure archives dir exists
  if (!fs.existsSync(archivesDir)) {
    fs.mkdirSync(archivesDir, { recursive: true });
  }

  const archiveName = `snapshots-${oldest}-to-${newest}.zip`;
  const archivePath = path.join(archivesDir, archiveName);

  console.log(
    chalk.yellow(`[archive] Snapshots size ${sizeMb.toFixed(2)} MB exceeds ${thresholdMb} MB threshold — rotating...`)
  );

  await zipDirectory(snapshotsDir, archivePath);

  const archiveStats = fs.statSync(archivePath);
  const archiveMb = archiveStats.size / (1024 * 1024);

  clearDateFolders(snapshotsDir, dateFolders);

  console.log(
    chalk.green(
      `[archive] Rotated ${sizeMb.toFixed(2)} MB → ${archiveMb.toFixed(2)} MB archive: ${archivePath}`
    )
  );

  return {
    rotated: true,
    size_mb: parseFloat(sizeMb.toFixed(3)),
    archive_path: archivePath,
  };
}

module.exports = { checkAndRotate };
