const fs = require('fs');

/**
 * Parses a Java-style .properties file into a key-value map.
 * Preserves special characters in values (URLs, passwords with $, *, @, =, etc.).
 *
 * @param {string} filePath - Absolute path to the .properties file.
 * @returns {Record<string, string>} Parsed key-value pairs.
 */
function parsePropertiesFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Configuration properties file not found: ${filePath}`);
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const properties = {};
  const lines = content.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i].trim();
    if (!rawLine || rawLine.startsWith('#') || rawLine.startsWith('!')) {
      continue;
    }

    const eqIdx = rawLine.indexOf('=');
    const colonIdx = rawLine.indexOf(':');

    let sepIdx = -1;
    if (eqIdx !== -1 && colonIdx !== -1) {
      sepIdx = Math.min(eqIdx, colonIdx);
    } else if (eqIdx !== -1) {
      sepIdx = eqIdx;
    } else if (colonIdx !== -1) {
      sepIdx = colonIdx;
    }

    if (sepIdx === -1) {
      continue;
    }

    const key = rawLine.slice(0, sepIdx).trim();
    const value = rawLine.slice(sepIdx + 1).trim();

    if (key) {
      properties[key] = value;
    }
  }

  return properties;
}

module.exports = { parsePropertiesFile };
