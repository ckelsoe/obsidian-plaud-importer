import { isPlaudOrigin } from '../plaud-login';

// The origin gate decides whether a sign-in window page may be a token
// source. It must accept only https Plaud origins: the capture guard
// validates JWT claims, not a signature, so any page an attacker can serve
// (plain http, a lookalike host, a non-Plaud origin) must be rejected here.
describe('isPlaudOrigin', () => {
	it('accepts https plaud.ai and subdomains', () => {
		expect(isPlaudOrigin('https://plaud.ai/')).toBe(true);
		expect(isPlaudOrigin('https://web.plaud.ai/login?from_url=%2F')).toBe(
			true,
		);
		expect(isPlaudOrigin('https://api-euc1.plaud.ai/some/path')).toBe(true);
		// Trailing-dot FQDN normalizes to the same host.
		expect(isPlaudOrigin('https://web.plaud.ai./')).toBe(true);
	});

	it('rejects plain http even on a plaud.ai host', () => {
		expect(isPlaudOrigin('http://plaud.ai/')).toBe(false);
		expect(isPlaudOrigin('http://web.plaud.ai/login')).toBe(false);
	});

	it('rejects non-Plaud and lookalike hosts', () => {
		expect(isPlaudOrigin('https://example.com/')).toBe(false);
		expect(isPlaudOrigin('https://evil-plaud.ai/')).toBe(false);
		expect(isPlaudOrigin('https://plaud.ai.attacker.example/')).toBe(false);
	});

	it('rejects other schemes and malformed input', () => {
		expect(isPlaudOrigin('file:///etc/passwd')).toBe(false);
		expect(isPlaudOrigin('javascript:alert(1)')).toBe(false);
		expect(isPlaudOrigin('not a url')).toBe(false);
		expect(isPlaudOrigin('')).toBe(false);
		expect(isPlaudOrigin(null)).toBe(false);
		expect(isPlaudOrigin(undefined)).toBe(false);
	});
});
