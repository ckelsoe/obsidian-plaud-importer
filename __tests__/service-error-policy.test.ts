/**
 * The core's classifyError knows nothing about any one service: it classifies
 * note-writer failures and the unknown fallback itself and asks the service's
 * policy about everything else. A fake service proves that contract without
 * Plaud's error classes.
 */
import { classifyError, type ServiceErrorPolicy } from '../import-core';
import { NoteWriterError } from '../note-writer';

class FakeServiceError extends Error {}

const FAKE_POLICY: ServiceErrorPolicy = {
	pluginName: 'Fake Importer',
	classify: (err) =>
		err instanceof FakeServiceError
			? { category: 'rate-limited', message: 'slow down', canRetry: true }
			: null,
	isUnprocessed: () => false,
};

describe('classifyError with a service policy', () => {
	it('returns the policy classification for a service error', () => {
		expect(classifyError(new FakeServiceError('x'), FAKE_POLICY)).toEqual({
			category: 'rate-limited',
			message: 'slow down',
			canRetry: true,
		});
	});

	it('falls back to unknown, naming the plugin, when the policy declines', () => {
		const result = classifyError(new Error('boom'), FAKE_POLICY);
		expect(result.category).toBe('unknown');
		expect(result.message).toContain('Unexpected error in Fake Importer.');
		expect(result.message).toContain('(boom)');
	});

	it('classifies note-writer config errors itself, naming the plugin', () => {
		const result = classifyError(
			new NoteWriterError('Output folder is invalid'),
			FAKE_POLICY,
		);
		expect(result.category).toBe('config-error');
		expect(result.message).toContain(
			'Community Plugins → Fake Importer to fix it.',
		);
	});

	it('never asks the policy about a note-writer error', () => {
		const classify = jest.fn(() => null);
		classifyError(new NoteWriterError('filename collision at a.md'), {
			...FAKE_POLICY,
			classify,
		});
		expect(classify).not.toHaveBeenCalled();
	});
});
