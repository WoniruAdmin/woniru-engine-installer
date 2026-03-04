async function executeSqlFileWithDelimiters(conn, sqlText, { onProgress } = {}) {
	// Normalize newlines + strip BOM
	let sql = String(sqlText || "").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");

	let delimiter = ";";
	let buf = "";

	// State flags
	let inSingle = false;
	let inDouble = false;
	let inBacktick = false;
	let inLineComment = false;
	let inBlockComment = false;

	function isEscaped(text, idx) {
		// count consecutive backslashes immediately before idx
		let n = 0;
		for (let i = idx - 1; i >= 0 && text[i] === "\\"; i--) n++;
		return (n % 2) === 1;
	}

	async function flushStatement(stmt) {
		const s = stmt.trim();
		if (!s) return;

		// Skip pure delimiter directives if they slipped through
		if (/^\s*DELIMITER\s+/i.test(s)) return;

		onProgress?.(s);

		// Execute statement as-is
		await conn.query(s);
	}

	// Handle DELIMITER directives line-by-line, but still allow delimiter detection char-by-char
	// We'll scan char-by-char and also watch for "DELIMITER xyz" at start of a line (not inside strings/comments).
	let lineStart = 0; // index after last '\n'

	for (let i = 0; i < sql.length; i++) {
		const ch = sql[i];
		const next = sql[i + 1];

		// Track line starts
		if (i === lineStart) {
			// if not inside strings/comments, check DELIMITER directive
			if (!inSingle && !inDouble && !inBacktick && !inLineComment && !inBlockComment) {
				// capture current line
				const lineEnd = sql.indexOf("\n", i);
				const endIdx = lineEnd === -1 ? sql.length : lineEnd;
				const line = sql.slice(i, endIdx);

				const m = line.match(/^\s*DELIMITER\s+(.+?)\s*$/i);
				if (m) {
					// Flush anything pending before changing delimiter (should usually be empty)
					if (buf.trim()) {
						await flushStatement(buf);
						buf = "";
					}
					delimiter = m[1];
					// Skip the directive line entirely
					i = endIdx; // loop will i++ then continue
					lineStart = i + 1;
					continue;
				}
			}
		}

		// Handle end of line comment
		if (inLineComment) {
			buf += ch;
			if (ch === "\n") {
				inLineComment = false;
				lineStart = i + 1;
			}
			continue;
		}

		// Handle block comment end
		if (inBlockComment) {
			buf += ch;
			if (ch === "*" && next === "/") {
				buf += "/";
				i++;
				inBlockComment = false;
			}
			continue;
		}

		// Enter comments (only if not inside strings/backticks)
		if (!inSingle && !inDouble && !inBacktick) {
			// -- comment (MySQL treats '-- ' as comment; we’ll accept '--' when followed by space/tab/newline/end)
			if (ch === "-" && next === "-") {
				const after = sql[i + 2];
				if (after === " " || after === "\t" || after === "\n" || after === "\r" || after === undefined) {
					buf += ch + next;
					i++;
					inLineComment = true;
					continue;
				}
			}
			// # comment
			if (ch === "#") {
				buf += ch;
				inLineComment = true;
				continue;
			}
			// /* block comment */
			if (ch === "/" && next === "*") {
				buf += ch + next;
				i++;
				inBlockComment = true;
				continue;
			}
		}

		// Toggle string/backtick states
		if (!inDouble && !inBacktick && ch === "'" && !isEscaped(sql, i)) {
			inSingle = !inSingle;
			buf += ch;
			continue;
		}
		if (!inSingle && !inBacktick && ch === `"` && !isEscaped(sql, i)) {
			inDouble = !inDouble;
			buf += ch;
			continue;
		}
		if (!inSingle && !inDouble && ch === "`") {
			inBacktick = !inBacktick;
			buf += ch;
			continue;
		}

		// Check delimiter (only when not inside strings/comments/backticks)
		if (!inSingle && !inDouble && !inBacktick && delimiter) {
			// Multi-char delimiter support (e.g. $$, //)
			if (delimiter.length === 1) {
				if (ch === delimiter) {
					// Statement ends BEFORE delimiter
					await flushStatement(buf);
					buf = "";
					continue; // do not include delimiter char
				}
			} else {
				if (sql.startsWith(delimiter, i)) {
					await flushStatement(buf);
					buf = "";
					i += (delimiter.length - 1);
					continue; // do not include delimiter chars
				}
			}
		}

		// Normal char
		buf += ch;

		if (ch === "\n") lineStart = i + 1;
	}

	// Flush remainder
	if (buf.trim()) {
		await flushStatement(buf);
	}
}

module.exports = { executeSqlFileWithDelimiters };