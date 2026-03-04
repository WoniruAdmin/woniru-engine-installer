// src/prompt.js
const readline = require("readline");

function ask(question) {
	return new Promise((resolve) => {
		const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
		rl.question(question, (answer) => {
			rl.close();
			resolve(answer);
		});
	});
}

module.exports = { ask };