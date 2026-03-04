// src/githubDownload.js
const fs = require("fs");
const path = require("path");

async function downloadRepoZip({ token, owner, repo, ref, outFile }) {
	const url = `https://api.github.com/repos/${owner}/${repo}/zipball/${encodeURIComponent(ref)}`;

	const res = await fetch(url, {
		method: "GET",
		headers: {
			"Accept": "application/vnd.github+json",
			"Authorization": `Bearer ${token}`,
			"X-GitHub-Api-Version": "2022-11-28",
			"User-Agent": "we-installer"
		},
		redirect: "follow"
	});

	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(
			`Repo download failed (HTTP ${res.status}). ` +
			`Are you a collaborator on ${owner}/${repo}? ` +
			`Response: ${body.slice(0, 200)}`
		);
	}

	const buf = Buffer.from(await res.arrayBuffer());
	fs.mkdirSync(path.dirname(outFile), { recursive: true });
	fs.writeFileSync(outFile, buf);
}

module.exports = { downloadRepoZip };