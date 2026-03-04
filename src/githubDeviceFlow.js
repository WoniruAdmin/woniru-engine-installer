// src/githubDeviceFlow.js

function formUrlEncode(obj) {
	return new URLSearchParams(obj).toString();
}

async function postForm(url, data) {
	const res = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			"Accept": "application/json"
		},
		body: formUrlEncode(data)
	});

	const json = await res.json().catch(() => ({}));
	if (!res.ok) {
		throw new Error(`POST ${url} failed (HTTP ${res.status}): ${JSON.stringify(json)}`);
	}
	return json;
}

async function requestDeviceCode({ clientId, scope = "repo" }) {
	const data = await postForm("https://github.com/login/device/code", {
		client_id: clientId,
		scope
	});

	if (!data.device_code || !data.user_code || !data.verification_uri) {
		throw new Error(`Unexpected device code response: ${JSON.stringify(data)}`);
	}
	return data;
}

async function pollForAccessToken({ clientId, deviceCode, intervalSeconds = 5, expiresInSeconds = 900 }) {
	const start = Date.now();
	let waitMs = Math.max(1, intervalSeconds) * 1000;

	while (true) {
		const elapsed = Date.now() - start;
		if (elapsed > expiresInSeconds * 1000) {
			throw new Error("Device code expired. Run auth again.");
		}

		const tokenResp = await postForm("https://github.com/login/oauth/access_token", {
			client_id: clientId,
			device_code: deviceCode,
			grant_type: "urn:ietf:params:oauth:grant-type:device_code"
		});

		if (tokenResp.access_token) {
			return tokenResp.access_token;
		}

		// Expected errors: authorization_pending, slow_down, access_denied, expired_token
		const err = tokenResp.error;

		if (err === "authorization_pending") {
			await new Promise(r => setTimeout(r, waitMs));
			continue;
		}

		if (err === "slow_down") {
			waitMs += 5000;
			await new Promise(r => setTimeout(r, waitMs));
			continue;
		}

		if (err === "access_denied") {
			throw new Error("Authorization denied by user in browser.");
		}

		if (err === "expired_token") {
			throw new Error("Device code expired. Run auth again.");
		}

		throw new Error(`Unexpected token response: ${JSON.stringify(tokenResp)}`);
	}
}

module.exports = { requestDeviceCode, pollForAccessToken };