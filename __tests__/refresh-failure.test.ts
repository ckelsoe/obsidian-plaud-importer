import {
	classifyEnvelope,
	classifyHttpStatus,
	deniedNoticeText,
	isRefreshFailure,
	isSsoRequired,
	type DeniedReason,
} from '../refresh-failure';

// The mapping mirrors Plaud's own 4.0 app (bundle read 2026-10-15). A wrong
// "denied" stops renewal for a session that was fine; a wrong "unreachable"
// retries a dead one. Both directions are pinned.
describe('classifyEnvelope', () => {
	it.each([-100, -101, -102, -104, -105, -401])(
		'treats the user-session status %p as session ended',
		(status) => {
			expect(classifyEnvelope({ status })).toEqual({
				failed: 'denied',
				reason: 'session-ended',
				status,
			});
		},
	);

	it('maps step-up and workspace-invalid to their own reasons', () => {
		expect(classifyEnvelope({ status: -2114 })).toMatchObject({
			failed: 'denied',
			reason: 'step-up-required',
		});
		expect(classifyEnvelope({ status: -3003 })).toMatchObject({
			failed: 'denied',
			reason: 'workspace-invalid',
		});
	});

	it('treats -419/-420 as ended only on the bearer path', () => {
		expect(classifyEnvelope({ status: -420 })).toMatchObject({
			failed: 'unreachable',
		});
		expect(
			classifyEnvelope({ status: -420 }, { expiredMeansDenied: true }),
		).toMatchObject({ failed: 'denied', reason: 'session-ended' });
		expect(
			classifyEnvelope({ status: -419 }, { expiredMeansDenied: true }),
		).toMatchObject({ failed: 'denied', reason: 'session-ended' });
	});

	it('treats an unrecognized or missing status as transient', () => {
		expect(classifyEnvelope({ status: -1 })).toMatchObject({
			failed: 'unreachable',
		});
		expect(classifyEnvelope({ status: -4302 })).toMatchObject({
			failed: 'unreachable',
		});
		expect(classifyEnvelope({})).toMatchObject({ failed: 'unreachable' });
	});

	it('recognizes company SSO from data or the top level', () => {
		expect(
			classifyEnvelope({
				status: -1,
				data: {
					error_code: 'SSO_REQUIRED',
					workos_organization_id: 'org_1',
				},
			}),
		).toMatchObject({ failed: 'denied', reason: 'sso-required' });
		expect(
			classifyEnvelope({
				status: -1,
				error_code: 'SSO_REQUIRED',
				workos_organization_id: 'org_1',
			}),
		).toMatchObject({ failed: 'denied', reason: 'sso-required' });
	});
});

describe('isSsoRequired', () => {
	it('needs the organization id beside the code, as Plaud does', () => {
		expect(isSsoRequired({ data: { error_code: 'SSO_REQUIRED' } })).toBe(
			false,
		);
		expect(
			isSsoRequired({
				data: {
					error_code: 'SSO_REQUIRED',
					workos_organization_id: '',
				},
			}),
		).toBe(false);
		expect(isSsoRequired({ data: { error_code: 'OTHER' } })).toBe(false);
	});
});

describe('classifyHttpStatus', () => {
	it('maps 410 to user-not-found and 401/403 to session ended', () => {
		expect(classifyHttpStatus(410)).toMatchObject({
			failed: 'denied',
			reason: 'user-not-found',
		});
		expect(classifyHttpStatus(401)).toMatchObject({
			failed: 'denied',
			reason: 'session-ended',
		});
		expect(classifyHttpStatus(403)).toMatchObject({
			failed: 'denied',
			reason: 'session-ended',
		});
	});

	it.each([408, 429, 500, 502, 503, 504])(
		'treats %p as transient',
		(code) => {
			expect(classifyHttpStatus(code)).toMatchObject({
				failed: 'unreachable',
			});
		},
	);
});

describe('isRefreshFailure', () => {
	it('tells a failure from a refreshed result', () => {
		expect(isRefreshFailure({ failed: 'denied', reason: 'x' })).toBe(true);
		expect(isRefreshFailure({ failed: 'unreachable', reason: 'x' })).toBe(
			true,
		);
		expect(isRefreshFailure({ token: 't', refreshToken: null })).toBe(
			false,
		);
		expect(isRefreshFailure(null)).toBe(false);
	});
});

describe('deniedNoticeText', () => {
	it.each<DeniedReason>([
		'session-ended',
		'user-not-found',
		'sso-required',
		'step-up-required',
		'workspace-invalid',
	])('gives %p a reconnect prompt', (reason) => {
		expect(deniedNoticeText(reason)).toMatch(/Reconnect/);
	});
});
