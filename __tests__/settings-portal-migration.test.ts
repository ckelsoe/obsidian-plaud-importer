import {
	DEFAULT_SETTINGS,
	DEFAULT_SIGN_IN_PORTAL_URL,
	isPreReleaseApiHost,
	migrateApiBaseUrl,
	migrateSignInPortalUrl,
} from '../settings-types';

describe('sign-in portal default', () => {
	it('is the production web app', () => {
		expect(DEFAULT_SIGN_IN_PORTAL_URL).toBe('https://web.plaud.ai');
		expect(DEFAULT_SETTINGS.signInPortalUrl).toBe(
			DEFAULT_SIGN_IN_PORTAL_URL,
		);
	});
});

describe('migrateSignInPortalUrl', () => {
	// Every earlier default moves forward: a vault that never touched the
	// setting stored the default of its day, and should not stay on it.
	it.each([
		'https://alpha.plaud.ai',
		'https://beta.plaud.ai',
		'https://beta.plaud.ai/',
		' https://beta.plaud.ai ',
	])('moves the retired default %p to web.plaud.ai', (stored) => {
		expect(migrateSignInPortalUrl(stored)).toBe('https://web.plaud.ai');
	});

	it.each([undefined, null, 42, '', '   '])(
		'repairs a missing or malformed value (%p) to the default',
		(stored) => {
			expect(migrateSignInPortalUrl(stored)).toBe('https://web.plaud.ai');
		},
	);

	// A portal the user typed is theirs, even one on a Plaud host.
	it.each([
		'https://web.plaud.ai',
		'https://beta.plaud.ai/file-list',
		'https://web-staging.plaud.ai',
		'https://eu.plaud.ai',
	])('keeps a chosen portal %p', (stored) => {
		expect(migrateSignInPortalUrl(stored)).toBe(stored);
	});
});

describe('migrateApiBaseUrl', () => {
	// beta.plaud.ai is being retired. Its servers share accounts and data with
	// production, so a session captured there moves to production on load.
	it.each([
		'https://api-test.plaud.ai',
		'https://api-test.plaud.ai/',
		'https://api-pre-euc1.plaud.ai',
		'https://API-PRE-APSE1.plaud.ai',
	])('moves the pre-release host %p to production', (stored) => {
		expect(migrateApiBaseUrl(stored)).toBe('https://api.plaud.ai');
	});

	it.each([
		'https://api.plaud.ai',
		'https://api-euc1.plaud.ai',
		'https://api-apne1.staging.theplaud.com',
		'https://api-pre-.plaud.ai',
		'https://api-pre-euc1.plaud.ai.evil.example',
		'not a url',
	])('keeps %p unchanged', (stored) => {
		expect(migrateApiBaseUrl(stored)).toBe(stored);
	});

	it.each([undefined, null, '', '  '])(
		'repairs a missing value (%p) to production',
		(stored) => {
			expect(migrateApiBaseUrl(stored)).toBe('https://api.plaud.ai');
		},
	);

	it('recognizes only real pre-release hosts', () => {
		expect(isPreReleaseApiHost('api-pre-euc1.plaud.ai')).toBe(true);
		expect(isPreReleaseApiHost('api-pre-x.y.plaud.ai')).toBe(false);
		expect(isPreReleaseApiHost('api-test.plaud.ai.evil')).toBe(false);
	});
});
