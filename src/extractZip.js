// src/extractZip.js
const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip");

function ensureDir(dir) {
	fs.mkdirSync(dir, { recursive: true });
}

function extractZipStripTopDir(zipFile, destDir) {
	ensureDir(destDir);

	const zip = new AdmZip(zipFile);
	const entries = zip.getEntries();

	// GitHub zipball structure: <repo>-<hash>/<files...>
	// We strip the first folder segment.
	for (const e of entries) {
		if (e.isDirectory) continue;

		const parts = e.entryName.split("/").filter(Boolean);
		if (parts.length < 2) continue;

		const relativePath = parts.slice(1).join("/"); // drop root folder
		const outPath = path.join(destDir, relativePath);

		ensureDir(path.dirname(outPath));
		fs.writeFileSync(outPath, e.getData());
	}
}

module.exports = { extractZipStripTopDir };