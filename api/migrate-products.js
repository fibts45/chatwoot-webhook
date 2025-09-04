const fs = require('fs');
const path = require('path');

function findLatestCsvFile(dataDir) {
  const files = fs.readdirSync(dataDir)
    .filter((f) => f.toLowerCase().endsWith('.csv'))
    .map((f) => ({
      file: f,
      mtime: fs.statSync(path.join(dataDir, f)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);
  if (files.length === 0) return null;
  return path.join(dataDir, files[0].file);
}

function splitCsvLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
        // Escaped quote
        current += '"';
        i += 1; // skip next quote
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

function parseCsv(content) {
  // Robust CSV parser supporting commas and newlines inside quoted fields
  const input = content.replace(/^\uFEFF/, ''); // strip BOM
  const rows = [];
  const currentRow = [];
  let currentField = '';
  let inQuotes = false;
  let i = 0;

  while (i < input.length) {
    const char = input[i];
    if (inQuotes) {
      if (char === '"') {
        // Escaped quote
        if (i + 1 < input.length && input[i + 1] === '"') {
          currentField += '"';
          i += 2;
          continue;
        }
        // End of quoted field
        inQuotes = false;
        i += 1;
        continue;
      }
      // Regular character inside quotes (including newlines)
      currentField += char;
      i += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (char === ',') {
      currentRow.push(currentField);
      currentField = '';
      i += 1;
      continue;
    }
    if (char === '\r') {
      // normalize CRLF or CR line endings
      i += 1;
      if (i < input.length && input[i] === '\n') i += 1;
      currentRow.push(currentField);
      rows.push(currentRow.slice());
      currentRow.length = 0;
      currentField = '';
      continue;
    }
    if (char === '\n') {
      i += 1;
      currentRow.push(currentField);
      rows.push(currentRow.slice());
      currentRow.length = 0;
      currentField = '';
      continue;
    }
    currentField += char;
    i += 1;
  }
  // flush last field/row
  currentRow.push(currentField);
  if (currentRow.length > 1 || (currentRow[0] && currentRow[0].trim() !== '')) {
    rows.push(currentRow);
  }

  if (rows.length === 0) return { headers: [], rows: [] };
  const headers = rows[0].map((h) => (h || '').trim());
  const mappedRows = [];
  for (let r = 1; r < rows.length; r += 1) {
    const raw = rows[r];
    if (raw.every((v) => (v || '').trim() === '')) continue; // skip empty
    const row = {};
    for (let c = 0; c < headers.length; c += 1) {
      let value = raw[c] ?? '';
      value = value.replace(/\r/g, '').replace(/\n/g, '\n');
      row[headers[c]] = value.trim();
    }
    mappedRows.push(row);
  }
  return { headers, rows: mappedRows };
}

function filterRows(rows) {
  return rows.filter((row) => {
    const name = (row['Name'] || '').trim();
    const published = (row['Veröffentlicht'] || '').toString().trim();
    const type = (row['Typ'] || '').toString().trim();
    const visibility = (row['Sichtbarkeit im Katalog'] || '').toString().trim();
    if (!name) return false;
    if (published && published !== '1') return false;
    if (type && type !== 'simple') return false;
    if (visibility && visibility !== 'visible') return false;
    return true;
  });
}

function buildAttributeMap(row) {
  const attributeMap = {};
  const maxAttributes = 12; // safety upper bound
  for (let i = 1; i <= maxAttributes; i += 1) {
    const nameKey = `Attribut ${i} Name`;
    const valueKey = `Attribut ${i} Wert(e)`;
    if (Object.prototype.hasOwnProperty.call(row, nameKey)) {
      const name = (row[nameKey] || '').trim();
      const value = (row[valueKey] || '').trim();
      if (name) attributeMap[name] = value;
    }
  }
  return attributeMap;
}

function mapRowToProduct(row) {
  const attributes = buildAttributeMap(row);

  const name = row['Name'] || '';
  const kurzbeschreibung = row['Kurzbeschreibung'] || '';
  const beschreibung = row['Beschreibung'] || '';
  const angebotspreis = (row['Angebotspreis'] || '').toString();
  const regulaererPreis = (row['Regulärer Preis'] || '').toString();
  const kategorien = row['Kategorien'] || '';
  const versandklasse = row['Versandklasse'] || '';
  const externeUrl = row['Externe URL'] || '';
  const id = (row['ID'] || '').toString().trim();

  // Attributes
  const hersteller = attributes['Hersteller'] || row['Marken'] || '';
  // Prefer explicit carrier and active ingredient; fall back to dose only if needed
  const traegerstoff = attributes['Trägerstoff'] || '';
  const wirkstoff = attributes['Wirkstoff'] || attributes['Wirkstoffe'] || attributes['Dosis'] || '';

  // Build object with keys ordered to match current JSON style
  const product = {
    name,
    kurzbeschreibung,
    beschreibung,
    angebotspreis,
    'regulärer_preis': regulaererPreis,
    kategorien,
    versandklasse,
    hersteller,
    'trägerstoff': traegerstoff,
    'wirkstoff': wirkstoff,
    permalink: externeUrl || (id ? `https://stero.biz/?p=${id}` : ''),
  };
  return product;
}

function migrate() {
  const dataDir = path.join(__dirname, '..', 'data');
  const csvFile = findLatestCsvFile(dataDir);
  if (!csvFile) {
    throw new Error('No CSV file found in data directory.');
  }

  const csvContent = fs.readFileSync(csvFile, 'utf8');
  const { rows } = parseCsv(csvContent);
  const filtered = filterRows(rows);
  const products = filtered.map(mapRowToProduct);

  const outFile = path.join(dataDir, 'products.json');
  const json = JSON.stringify(products, null, 2);
  fs.writeFileSync(outFile, json, 'utf8');
  // eslint-disable-next-line no-console
  console.log(`Wrote ${products.length} products to ${outFile}`);
}

if (require.main === module) {
  try {
    migrate();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(err.message || err);
    process.exit(1);
  }
}


