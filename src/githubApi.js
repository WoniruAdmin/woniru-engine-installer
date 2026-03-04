// src/githubApi.js
async function getGithubUser({ token }) {
	const res = await fetch("https://api.github.com/user", {
		method: "GET",
		headers: {
			"Accept": "application/vnd.github+json",
			"Authorization": `Bearer ${token}`,
			"X-GitHub-Api-Version": "2022-11-28",
			"User-Agent": "we-npx-installer"
		}
	});

	const data = await res.json().catch(() => ({}));

	if (!res.ok) {
		throw new Error(`Failed to fetch GitHub user (HTTP ${res.status}): ${JSON.stringify(data)}`);
	}

	return data; // contains login, id, name, etc
}

module.exports = { getGithubUser };