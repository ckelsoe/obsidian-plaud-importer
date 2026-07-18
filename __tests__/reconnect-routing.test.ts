import { preferWindowForReconnect } from '../reconnect-routing';

// Reconnect must reopen the surface that can actually re-auth the account:
// the embedded window for email sessions, the browser flow for Google/Apple.
// Pre-0.32.0 sessions have no recorded method; for those the stored legacy
// refresh token (only ever written by the embedded email window) is the
// signal.
describe('preferWindowForReconnect', () => {
	const noLegacy = () => null;

	it('routes a recorded window session to the embedded window', () => {
		expect(preferWindowForReconnect('window', noLegacy)).toBe(true);
		// The recorded method wins even if a stale legacy token disagrees.
		expect(preferWindowForReconnect('window', () => '')).toBe(true);
	});

	it('routes a recorded browser session to the browser flow', () => {
		expect(preferWindowForReconnect('browser', noLegacy)).toBe(false);
		// The recorded method wins even if a legacy WRT is still stored.
		expect(preferWindowForReconnect('browser', () => 'legacy-wrt')).toBe(false);
	});

	describe('legacy sessions (no recorded method)', () => {
		it('routes to the window when a legacy refresh token is stored', () => {
			expect(preferWindowForReconnect('', () => 'legacy-wrt')).toBe(true);
		});

		it('routes to the browser when no legacy token exists', () => {
			expect(preferWindowForReconnect('', noLegacy)).toBe(false);
		});

		it('treats a blank or whitespace legacy value as absent', () => {
			expect(preferWindowForReconnect('', () => '')).toBe(false);
			expect(preferWindowForReconnect('', () => '   ')).toBe(false);
		});

		it('routes to the browser when the legacy reader throws', () => {
			expect(
				preferWindowForReconnect('', () => {
					throw new Error('secret storage unavailable');
				}),
			).toBe(false);
		});
	});
});
