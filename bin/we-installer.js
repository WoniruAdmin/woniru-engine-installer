#!/usr/bin/env node

const { runAuth } = require("../src/auth");
const { runDownload } = require("../src/download");

const command = process.argv[2];

(async () => {
	if (!command) {
		console.log("Usage: we-installer <command>");
		console.log("Commands:");
		console.log("  auth       Authenticate with GitHub");
		console.log("  install    Auth + download repo");
		process.exit(0);
	}

	if (command === "auth") {
		await runAuth();
		return;
	}

	if (command === "install") {
		const { token, user, ui } = await runAuth(); // make sure runAuth returns ui as well (see note below)
		await runDownload({ token, ui });
		console.log(`Done. Authenticated as ${user.login}.`);
		return;
	}

	console.log(`Unknown command: ${command}`);
	process.exit(1);
})().catch((err) => {
	console.error("Error:", err.message);
	process.exit(1);
});