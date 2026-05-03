const path = require('path');

function detectSeriesName(filePath) {
  if (!filePath) return null;

  // Normalize and split by path separators
  const parts = filePath.split(/[/\\]/);
  // Remove the file name itself
  parts.pop();

  if (parts.length === 0) return null;

  let targetFolderName = parts[parts.length - 1];

  // If the parent folder looks like a season folder
  const seasonPattern = /^(season\s*\d+|s\d+|season\s+one|season\s+two|season\s+three)$/i;
  if (seasonPattern.test(targetFolderName) && parts.length > 1) {
    targetFolderName = parts[parts.length - 2];
  }

  // Clean the result: remove dots, underscores, replace with spaces
  let cleaned = targetFolderName.replace(/[._]/g, ' ');

  // Trim year patterns like (2018) or 2018
  cleaned = cleaned.replace(/\(\d{4}\)/g, '');
  cleaned = cleaned.replace(/\b(19|20)\d{2}\b/g, '');

  // Replace multiple spaces with single space and trim
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  return cleaned || targetFolderName; // Fallback if we accidentally cleaned everything
}

function detectEpisodeLabel(fileName) {
  if (!fileName) return null;

  // 1. `S##E##` pattern → return as-is e.g. `S02E05`
  const sxxexx = fileName.match(/S\d+E\d+/i);
  if (sxxexx) return sxxexx[0].toUpperCase();

  // 2. `##x##` pattern → convert to `S##E##`
  const xPattern = fileName.match(/(\d+)x(\d+)/i);
  if (xPattern) {
    const s = xPattern[1].padStart(2, '0');
    const e = xPattern[2].padStart(2, '0');
    return `S${s}E${e}`;
  }

  // 3. `Season # Episode #` → convert to `S##E##`
  const seasonEpPattern = fileName.match(/Season\s+(\d+)\s+Episode\s+(\d+)/i);
  if (seasonEpPattern) {
    const s = seasonEpPattern[1].padStart(2, '0');
    const e = seasonEpPattern[2].padStart(2, '0');
    return `S${s}E${e}`;
  }

  // 4. `Episode ##` or `EP##` or `E##` → return `Ep.##`
  const epPattern = fileName.match(/(?:^|[\s._-])(Episode|EP|E)[\s.-]*(\d+)/i);
  if (epPattern) {
    return `Ep.${epPattern[2].padStart(2, '0')}`;
  }

  // 5. If no pattern matches → return `null`
  return null;
}

module.exports = {
  detectSeriesName,
  detectEpisodeLabel
};
