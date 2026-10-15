import {
	DEFAULT_SETTINGS,
	DEFAULT_SIGN_IN_PORTAL_URL,
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
