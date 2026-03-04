// src/download.js
const os = require("os");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

const { ask } = require("./prompt");
const { downloadRepoZip } = require("./githubDownload");
const { extractZipStripTopDir } = require("./extractZip");

function parseRepo(repoStr) {
	const [owner, repo] = String(repoStr || "").split("/");
	if (!owner || !repo) throw new Error("WE_GITHUB_REPO must be like: Owner/Repo");
	return { owner, repo };
}

function dirExists(p) {
	try { return fs.statSync(p).isDirectory(); }
	catch { return false; }
}

function isDirEmpty(p) {
	const entries = fs.readdirSync(p);
	return entries.length === 0;
}

async function waitForInstallChoice(ui) {
	ui?.setPhase("install");
	ui?.setStatus("Choose install location in the browser: Accept (use current directory) or Choose manually…");

	while (true) {
		const choice = ui?.getInstallChoice?.();
		if (choice === "accept" || choice === "manual") return choice;
		await new Promise(r => setTimeout(r, 400));
	}
}

async function runNpmInstall(targetDir, ui) {
	return new Promise((resolve, reject) => {
		ui?.setPhase("npm");
		ui?.setStatus("Installing dependencies (npm install)…");

		console.log("\nRunning npm install...\n");

		const child = spawn("npm", ["install"], {
			cwd: targetDir,
			stdio: "inherit",
			shell: process.platform === "win32"
		});

		child.on("close", (code) => {
			if (code === 0) {
				ui?.setStatus("Dependencies installed successfully ✅");
				resolve();
			} else {
				ui?.setStatus("npm install failed ❌");
				reject(new Error(`npm install exited with code ${code}`));
			}
		});
	});
}

async function runDownload({ token, ui }) {
	const repoStr = 'yathanshsharma/woniru-crm';
	const ref = "main";
	const { owner, repo } = parseRepo(repoStr);

	const choice = await waitForInstallChoice(ui);

	const defaultDir = path.join(process.cwd(), "woniru-engine");
	let targetDir;

	if (choice === "accept") {
		targetDir = defaultDir;
		console.log(`Using default install directory: ${targetDir}`);
	} else {
		console.log("Manual selection chosen in browser.");
		const answer = await ask(`Install location (must be empty) [default: ${defaultDir}]: `);
		targetDir = (answer && answer.trim()) ? path.resolve(answer.trim()) : defaultDir;
	}

	// enforce empty or non-existent directory
	if (dirExists(targetDir)) {
		if (!isDirEmpty(targetDir)) {
			ui?.setStatus(`Failed ❌ Install directory not empty: ${targetDir}`);
			throw new Error(`Install directory must be empty: ${targetDir}`);
		}
	} else {
		fs.mkdirSync(targetDir, { recursive: true });
	}

	const zipPath = path.join(os.tmpdir(), `we-installer-${repo}-${Date.now()}.zip`);

	ui?.setPhase("download");
	ui?.setStatus(`Downloading ${owner}/${repo}@${ref}…`);
	console.log(`Downloading ${owner}/${repo}@${ref}...`);

	await downloadRepoZip({ token, owner, repo, ref, outFile: zipPath });

	ui?.setStatus(`Extracting into: ${targetDir}…`);
	console.log(`Extracting to: ${targetDir}...`);

	extractZipStripTopDir(zipPath, targetDir);

	ui?.setStatus("Download complete ✅");

	// ---------------------
	// NEW: npm stage
	// ---------------------
	await runNpmInstall(targetDir, ui);
	ui.setInstallDir(targetDir);

	// Move to wizard phase
	ui?.setPhase("configure");
	ui?.setStatus("Installation complete. Opening configuration wizard…");

	console.log("\n🎉 Installation complete.");
	console.log(`Path: ${targetDir}`);

	return { targetDir };
}

module.exports = { runDownload };