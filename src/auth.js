// src/auth.js
const { requestDeviceCode, pollForAccessToken } = require("./githubDeviceFlow");
const { startAuthServer } = require("./authServer");
const { getGithubUser } = require("./githubApi");

function openBrowserNative(url) {
	const { exec } = require("child_process");
	const platform = process.platform;

	// Best-effort open; no external deps
	if (platform === "win32") exec(`start "" "${url}"`);
	else if (platform === "darwin") exec(`open "${url}"`);
	else exec(`xdg-open "${url}"`);
}

/**
 * Auth flow:
 * 1) Request device code
 * 2) Start local server + open browser
 * 3) Poll GitHub for access token
 * 4) Fetch /user to confirm identity
 * 5) Switch UI phase to "install" so the page shows Accept/Manual section
 *
 * Returns: { token, user, ui }
 */
async function runAuth() {
	const clientId = 'Ov23lifTq8hC15zQcG4C';
	if (!clientId) throw new Error("Missing env var WE_GITHUB_CLIENT_ID");

	// Optional: allow overriding scope later; default is repo for private repo access
	const scope = "repo";

	console.log("Requesting GitHub device code...");
	const device = await requestDeviceCode({ clientId, scope });

	const ui = await startAuthServer({
		verificationUri: device.verification_uri,
		userCode: device.user_code
	});

	console.log("\nOpen this page to continue:");
	console.log(ui.url + "\n");

	// Best-effort open browser (user can still open manually from printed URL)
	try { openBrowserNative(ui.url); } catch { }

	// Phase: auth
	ui.setPhase("auth");
	ui.setStatus("Waiting for approval in GitHub…");

	// Poll for access token
	let token;
	try {
		token = await pollForAccessToken({
			clientId,
			deviceCode: device.device_code,
			intervalSeconds: device.interval ?? 5,
			expiresInSeconds: device.expires_in ?? 900
		});
	} catch (err) {
		ui.setStatus(`Authorization failed ❌ ${err.message}`);
		throw err;
	}

	// Verify identity
	ui.setStatus("Authorized ✅ Verifying identity…");

	let me;
	try {
		me = await getGithubUser({ token });
	} catch (err) {
		ui.setStatus(`Failed to verify identity ❌ ${err.message}`);
		throw err;
	}

	ui.setUserLogin(me.login);
	console.log(`✅ GitHub authentication successful as: ${me.login}`);

	// ✅ THIS is the “one line” you were looking for:
	// Move UI to install-choice phase so the page hides auth controls and shows Accept/Manual.
	ui.setPhase("install");
	ui.setStatus("Choose install location in the browser: Accept (use current directory) or Choose manually…");

	return { token, user: me, ui };
}

module.exports = { runAuth };