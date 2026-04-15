import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { zip } from 'bestzip';

const manifestRaw = await readFile('manifest.json', 'utf8');
const manifest = JSON.parse(manifestRaw);
const pluginId =
	typeof manifest.id === 'string' && manifest.id.trim().length > 0
		? manifest.id.trim()
		: 'plugin';
const pluginVersion =
	typeof manifest.version === 'string' && manifest.version.trim().length > 0
		? manifest.version.trim()
		: '0.0.0';

await mkdir('brat', { recursive: true });

const zipName = `${pluginId}-${pluginVersion}.zip`;
const zipPath = path.join('brat', zipName);
await zip({
	source: ['manifest.json', 'main.js', 'styles.css', 'versions.json'],
	destination: zipPath,
});

console.log(`BRAT package created: ${zipPath}`);
