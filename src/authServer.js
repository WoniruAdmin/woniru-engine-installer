// src/authServer.js
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const mysql = require("mysql2/promise");
const { executeSqlFileWithDelimiters } = require("./sqlRunner.js");

// node-redis (install in installer package): npm i redis
const { createClient } = require("redis");

function loadTemplate(fileName, replacements = {}) {
	const templatePath = path.join(__dirname, "..", "templates", fileName);
	let html = fs.readFileSync(templatePath, "utf8");

	for (const [k, v] of Object.entries(replacements)) {
		html = html.replaceAll(k, String(v));
	}
	return html;
}

function runCommand(cmd, args, { cwd, statusCb }) {
	return new Promise((resolve, reject) => {
		statusCb?.(`Running: ${cmd} ${args.join(" ")}`);

		const child = spawn(cmd, args, {
			cwd,
			stdio: "inherit",
			shell: process.platform === "win32"
		});

		child.on("close", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`${cmd} ${args.join(" ")} exited with code ${code}`));
		});
	});
}

function readSchemaSql(installDir) {
	// You can change this default anytime.
	// Put schema at: <installedProject>/db/schema.sql OR <installedProject>/schema.sql
	const candidates = [
		path.join(installDir, "DB Backup", "WoniruCRMMeta.sql"),
		path.join(installDir, "schema.sql")
	];

	for (const p of candidates) {
		if (fs.existsSync(p)) return { filePath: p, sql: fs.readFileSync(p, "utf8") };
	}

	throw new Error("Schema file not found. Expected db/schema.sql or schema.sql in install directory.");
}

async function readJsonBody(req) {
	return new Promise((resolve, reject) => {
		let body = "";
		req.on("data", (chunk) => {
			body += chunk;
			if (body.length > 200_000) reject(new Error("Request body too large"));
		});
		req.on("end", () => {
			try {
				resolve(JSON.parse(body || "{}"));
			} catch {
				reject(new Error("Bad JSON"));
			}
		});
	});
}

function randomKey() {
	// strong, URL-safe-ish key
	return crypto.randomBytes(32).toString("base64url");
}

async function withRedisClient({ host, port, username, password }, fn) {
	const url = `redis://${(password && username != 'default') ? encodeURIComponent(username) + ":" + encodeURIComponent(password) + "@" : ""}${host}:${port}`;
	const client = createClient({ url });
	client.on("error", () => { /* handled by connect/commands */ });

	await client.connect();
	try {
		return await fn(client);
	} finally {
		try { await client.quit(); } catch { }
	}
}

function startAuthServer({ verificationUri, userCode }) {
	const state = {
		// Progress (auth page uses /status to drive phase + redirect)
		phase: "auth", // auth | install | download | npm | configure
		status: "Waiting for approval in GitHub…",
		userLogin: null,

		// Install selection
		cwd: process.cwd(),
		installChoice: null, // accept | manual | null

		// Installer runtime context
		installDir: null, // set by CLI once directory is decided

		// Configure wizard data
		configure: {
			step: 1,
			redis: {
				existing: false,
				adminKey: "",
				// will be generated only when existing=false and setup runs
				sessUserKey: "",
				permUserKey: "",
				aclFilePath: ""
			},
			db: {
				host: "",
				user: "",
				password: "",
				name: ""
			}
		}
	};

	const server = http.createServer(async (req, res) => {
		try {
			// -------------------------
			// Status endpoint
			// -------------------------
			if (req.url === "/status") {
				res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
				res.end(JSON.stringify({
					phase: state.phase,
					status: state.status,
					userLogin: state.userLogin
				}));
				return;
			}

			// -------------------------
			// Context endpoint
			// -------------------------
			if (req.url === "/context") {
				res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
				res.end(JSON.stringify({
					cwd: state.cwd,
					installChoice: state.installChoice
				}));
				return;
			}

			// -------------------------
			// Install choice (accept/manual)
			// -------------------------
			if (req.url === "/install-choice" && req.method === "POST") {
				const data = await readJsonBody(req);
				const choice = data.choice;

				if (choice !== "accept" && choice !== "manual") {
					res.writeHead(400, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ ok: false, error: "Invalid choice" }));
					return;
				}

				state.installChoice = choice;
				res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
				res.end(JSON.stringify({ ok: true }));
				return;
			}

			// -------------------------
			// Configure: get state (Step 1/2 rendering)
			// -------------------------
			if (req.url === "/configure/state") {
				res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
				res.end(JSON.stringify({
					step: state.configure.step,
					installDir: state.installDir,
					redis: {
						existing: state.configure.redis.existing,
						adminKey: state.configure.redis.adminKey,
						aclFilePath: state.configure.redis.aclFilePath
					},
					db: state.configure.db
				}));
				return;
			}

			// -------------------------
			// Configure Step 1: apply Redis choice
			//
			// Rules:
			// - Always collect adminKey.
			// - If existing=true:
			//    - do NOT create users
			//    - just test connection as admin@127.0.0.1:6379 (PING)
			// - If existing=false:
			//    - create users (admin/sess_user/perm_user + default off)
			//    - set aclfile + ACL SAVE
			// - On success -> advance to step 2
			// -------------------------
			if (req.url === "/configure/redis/apply" && req.method === "POST") {
				const data = await readJsonBody(req);
				const existing = !!data.existing;
				const adminKey = (data.adminKey || "").toString();

				if (!adminKey || adminKey.trim().length < 8) {
					res.writeHead(400, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ ok: false, error: "Redis admin key must be at least 8 characters." }));
					return;
				}

				// persist what user entered
				state.configure.redis.existing = existing;
				state.configure.redis.adminKey = adminKey;

				const host = "127.0.0.1";
				const port = 6379;
				const username = "default";

				// Attempt connection as admin
				state.status = existing
					? "Testing Redis connection (admin@127.0.0.1:6379)…"
					: "Connecting to Redis to configure ACL users…";

				try {
					if (existing) {
						await withRedisClient({ host, port, username: 'admin', password: adminKey }, async (client) => {
							const pong = await client.ping();
							if (!pong) throw new Error("No PING response");
						});

						state.configure.step = 2; // proceed
						res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
						res.end(JSON.stringify({ ok: true, nextStep: 2 }));
						return;
					}

					// Not existing: we configure ACL users + save aclfile
					// Ensure we have an installDir to write the ACL file into
					if (!state.installDir) {
						throw new Error("Installer installDir not set yet. (Internal error: missing install directory)");
					}

					/* const aclDir = path.join(state.installDir, "config");
					fs.mkdirSync(aclDir, { recursive: true });

					const aclFilePath = path.join(aclDir, "redis-users.acl");
					state.configure.redis.aclFilePath = aclFilePath; */

					state.status = "Building Redis docker image (no-cache)…";
					await runCommand("docker", ["compose", "build", "--no-cache"], {
						cwd: state.installDir,
						statusCb: (s) => (state.status = s)
					});

					state.status = "Starting Redis container…";
					await runCommand("docker", ["compose", "up", "-d"], {
						cwd: state.installDir,
						statusCb: (s) => (state.status = s)
					});

					// Optional: small delay before first connect (helps on slower machines)
					await new Promise(r => setTimeout(r, 1200));

					const sessKey = randomKey();
					const permKey = randomKey();

					await withRedisClient({ host, port, username, password: adminKey }, async (client) => {
						// Create/modify users as per your rules
						// admin user
						await client.sendCommand(["ACL", "SETUSER", "admin", "ON", `>${adminKey}`, "+@all"]);

						// session user
						await client.sendCommand([
							"ACL", "SETUSER", "sess_user",
							"ON", `>${sessKey}`,
							"~sess:*",
							"+ping", "+get", "+set", "+del",
							"+expire", "+pexpire", "+ttl", "+pttl", "+exists"
						]);

						// permission user
						await client.sendCommand([
							"ACL", "SETUSER", "perm_user",
							"ON", `>${permKey}`,
							"~userPerm:*",
							"+ping", "+get", "+set", "+del",
							"+expire", "+pexpire", "+ttl", "+pttl", "+exists",
							"+hget", "+hset", "+hdel", "+hmget", "+hgetall",
							"+sadd", "+srem", "+smembers", "+scard", "+scan",
							"+hscan", "+sscan"
						]);

						// Turn off default user
						await client.sendCommand(["ACL", "SETUSER", "default", "OFF"]);

						// Point Redis at our aclfile, then save
						// await client.sendCommand(["CONFIG", "SET", "aclfile", aclFilePath]);
						await client.sendCommand(["ACL", "SAVE"]);
					});

					// store generated keys in state (we’ll persist later to real secrets storage)
					state.configure.redis.sessUserKey = sessKey;
					state.configure.redis.permUserKey = permKey;

					state.configure.step = 2; // proceed
					res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
					res.end(JSON.stringify({ ok: true, nextStep: 2 }));
					return;

				} catch (err) {
					res.writeHead(400, { "Content-Type": "application/json", "Cache-Control": "no-store" });
					res.end(JSON.stringify({ ok: false, error: err.message || "Redis step failed" }));
					return;
				}
			}

			// -------------------------
			// Configure Step 2: apply DB (MySQL)
			// - Save DB inputs
			// - Test connection
			// - Create DB if missing (if permitted)
			// - Apply schema.sql using mysql2 (remote-safe)
			// - On success -> advance to step 3
			// -------------------------
			if (req.url === "/configure/db/apply" && req.method === "POST") {
				const data = await readJsonBody(req);

				const host = (data.host || "").toString().trim();
				const user = (data.user || "").toString().trim();
				const password = (data.password || "").toString();
				const dbName = (data.name || "").toString().trim();

				if (!host) {
					res.writeHead(400, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ ok: false, error: "DB host is required." }));
					return;
				}
				if (!user) {
					res.writeHead(400, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ ok: false, error: "DB user is required." }));
					return;
				}
				if (!dbName) {
					res.writeHead(400, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ ok: false, error: "DB name is required." }));
					return;
				}
				if (!state.installDir) {
					res.writeHead(400, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ ok: false, error: "Install directory not set (internal error)." }));
					return;
				}

				// persist
				state.configure.db.host = host;
				state.configure.db.user = user;
				state.configure.db.password = password;
				state.configure.db.name = dbName;

				try {
					state.status = "Testing database connection…";

					// 1) connect without selecting database (so we can CREATE DATABASE if needed)
					const adminConn = await mysql.createConnection({
						host,
						user,
						password,
						// NOTE: no database here on purpose
						multipleStatements: false
					});

					// 2) ensure database exists (best-effort)
					state.status = `Ensuring database exists: ${dbName}…`;
					await adminConn.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\``);
					await adminConn.end();

					state.status = "Reading schema file…";
					const { filePath, sql } = readSchemaSql(state.installDir);

					state.status = "Applying database schema…";

					const dbConn = await mysql.createConnection({
						host,
						user,
						password,
						database: dbName,
						multipleStatements: false // IMPORTANT: we execute statements one-by-one
					});

					await executeSqlFileWithDelimiters(dbConn, sql, {
						onProgress: () => {
							// keep this light; don’t spam huge SQL into status
							state.status = "Applying database schema…";
						}
					});

					await dbConn.end();

					fs.writeFileSync(path.join(state.installDir, "meta.json"), JSON.stringify({
						databaseType: "mysql",
						databaseHost: host,
						databasePort: "3306",
						databaseMeta: dbName
					}, null, 2));

					// 5) advance to step 3
					state.configure.step = 3;
					state.status = `Database ready ✅ (${dbName})`;

					res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
					res.end(JSON.stringify({ ok: true, nextStep: 3, schemaFile: filePath }));
					return;

				} catch (err) {
					res.writeHead(400, { "Content-Type": "application/json", "Cache-Control": "no-store" });
					res.end(JSON.stringify({
						ok: false,
						error: err.message || "Database step failed"
					}));
					return;
				}
			}

			// -------------------------
			// Configure: done/exit signal
			// - Browser calls this on Finish and on unload
			// - CLI can end after server closes
			// -------------------------
			if (req.url === "/configure/done" && (req.method === "POST" || req.method === "GET")) {
				state.status = "Installer finished. Closing…";

				res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
				res.end(JSON.stringify({ ok: true }));

				// Close the HTTP server right after responding
				setTimeout(() => {
					try { server.close(); } catch { }
				}, 1000);

				return;
			}

			// -------------------------
			// Pages
			// -------------------------
			if (req.url === "/" || req.url.startsWith("/?")) {
				const html = loadTemplate("auth.html", {
					"{{USER_CODE}}": userCode,
					"{{VERIFICATION_URI}}": verificationUri
				});
				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
				res.end(html);
				return;
			}

			if (req.url === "/configure" || req.url.startsWith("/configure?")) {
				const html = loadTemplate("configure.html", {});
				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
				res.end(html);
				return;
			}

			res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
			res.end("Not Found");
		} catch (err) {
			res.writeHead(500, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok: false, error: err.message || "Server error" }));
		}
	});

	return new Promise((resolve, reject) => {
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const port = server.address().port;

			resolve({
				url: `http://127.0.0.1:${port}/`,

				// setters used by CLI
				setStatus: (s) => { state.status = String(s); },
				setPhase: (p) => { state.phase = String(p); },
				setUserLogin: (login) => { state.userLogin = login ? String(login) : null; },
				setInstallDir: (dir) => { state.installDir = dir ? String(dir) : null; },

				// getters used by CLI
				getInstallChoice: () => state.installChoice,
				getCwd: () => state.cwd,

				close: () => new Promise((r) => server.close(() => r()))
			});
		});
	});
}

module.exports = { startAuthServer };