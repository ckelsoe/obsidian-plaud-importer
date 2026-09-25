// Installs the git hooks during `npm install`, and skips quietly when husky is
// not installed (a production-only install such as `npm ci --omit=dev` still
// runs `prepare`, and a bare `husky` would fail it). Node, not a shell `||`
// chain, so it behaves the same on Windows.
try {
	const { default: husky } = await import("husky");
	console.log(husky());
} catch (err) {
	if (err?.code !== "ERR_MODULE_NOT_FOUND") {
		throw err;
	}
}
