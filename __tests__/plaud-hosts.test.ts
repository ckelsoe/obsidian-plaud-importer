import { isTrustedPlaudHost, isTrustedPlaudUrl } from '../plaud-hosts';

describe('isTrustedPlaudHost', () => {
	it('accepts plaud.ai and its subdomains', () => {
		expect(isTrustedPlaudHost('plaud.ai')).toBe(true);
		expect(isTrustedPlaudHost('api.plaud.ai')).toBe(true);
		expect(isTrustedPlaudHost('api-euc1.plaud.ai')).toBe(true);
		expect(isTrustedPlaudHost('alpha.plaud.ai')).toBe(true);
	});

	it('accepts theplaud.com and its subdomains (the alpha v4 hosts)', () => {
		expect(isTrustedPlaudHost('theplaud.com')).toBe(true);
		expect(isTrustedPlaudHost('api-apne1.staging.theplaud.com')).toBe(true);
	});

	it('is case-insensitive and tolerates a trailing dot', () => {
		expect(isTrustedPlaudHost('API.PLAUD.AI')).toBe(true);
		expect(isTrustedPlaudHost('api.plaud.ai.')).toBe(true);
	});

	it('rejects look-alike and unrelated hosts', () => {
		expect(isTrustedPlaudHost('plaud.ai.evil.com')).toBe(false);
		expect(isTrustedPlaudHost('notplaud.ai')).toBe(false);
		expect(isTrustedPlaudHost('theplaud.com.evil.com')).toBe(false);
		expect(isTrustedPlaudHost('evil.com')).toBe(false);
		// A substring match must not pass: only a dot-boundary suffix counts.
		expect(isTrustedPlaudHost('faketheplaud.com')).toBe(false);
	});
});

describe('isTrustedPlaudUrl', () => {
	it('accepts https URLs on trusted hosts', () => {
		expect(isTrustedPlaudUrl('https://alpha.plaud.ai')).toBe(true);
		expect(
			isTrustedPlaudUrl('https://api-apne1.staging.theplaud.com/x'),
		).toBe(true);
	});

	it('rejects non-https, credentialed, or untrusted URLs', () => {
		expect(isTrustedPlaudUrl('http://alpha.plaud.ai')).toBe(false);
		// Fake placeholder creds, not a secret: this asserts a credentialed URL
		// is rejected so a token can never be sent to an attacker-in-the-userinfo.
		const credentialed = 'https://user:pass@alpha.plaud.ai'; // gitleaks:allow
		expect(isTrustedPlaudUrl(credentialed)).toBe(false);
		expect(isTrustedPlaudUrl('https://evil.com')).toBe(false);
		expect(isTrustedPlaudUrl('not a url')).toBe(false);
	});
});
