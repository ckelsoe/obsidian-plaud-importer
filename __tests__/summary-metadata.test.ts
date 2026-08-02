import { findSummaryMetadata } from '../plaud-client-re';

// Golden fixture: the STRUCTURE of a real `/file/detail/{id}` response,
// captured live from web.plaud.ai on 2026-07-09 while diagnosing issue #61
// (a recording with an "Adaptive Summary" template generated on model
// gpt-5.5). Values are synthetic/redacted; the NESTING is verbatim to the
// live payload — the summary metadata is split across the `auto_sum_note`
// entry's `extra` and `extra_data`, which is exactly the shape that broke
// the old flat-`/ai/transsumm`-envelope parse. If Plaud moves these fields
// again, re-capture and diff this fixture: the failing assertion names the
// field that moved.
const DETAIL_2026_07_09 = {
	status: 0,
	msg: 'ok',
	request_id: 'redacted',
	data: {
		file_id: 'redacted-file-id',
		file_name: '07-08 Example recording',
		content_list: [
			{ data_type: 'transaction', extra: {} },
			{ data_type: 'outline', extra: {} },
			{ data_type: 'transaction_polish', extra: {} },
			{
				data_type: 'auto_sum_note',
				extra: {
					summary_id: '20260708183602-v2@redacted',
					summ_type: 'AI-CHOICE',
					summ_type_type: 'system',
					used_template: {
						template_type: 'official',
						template_id: 'AI-CHOICE',
						template_version_id: '',
						template_name: 'Adaptive Summary',
					},
				},
			},
		],
		extra_data: {
			model: 'gpt-5.5',
			aiContentHeader: {
				headline: 'Example headline for the recording',
				category: 'Adaptive Summary',
				original_category: 'Adaptive Summary',
				industry_category: 'redacted-industry',
				summary_id: '20260708183602-v2@redacted',
				used_template: {
					template_id: 'AI-CHOICE',
					template_type: 'official',
					template_version_id: '',
				},
				recommend_questions: [
					{ category: 'key_insights' },
					{ category: 'subtext' },
				],
			},
			used_template: {
				template_id: 'AI-CHOICE',
				template_type: 'official',
				template_version_id: '',
			},
		},
	},
};

const endpoint = '/file/detail/redacted';

describe('findSummaryMetadata (issue #61 — newer summary path)', () => {
	it('resolves template, model, headline, category, summary_id from the drift-era detail shape', () => {
		expect(findSummaryMetadata(DETAIL_2026_07_09, endpoint)).toEqual({
			template: 'Adaptive Summary',
			model: 'gpt-5.5',
			headline: 'Example headline for the recording',
			category: 'Adaptive Summary',
			industry: 'redacted-industry',
			summaryId: '20260708183602-v2@redacted',
		});
	});

	it('prefers the human-readable template_name over the summ_type code', () => {
		expect(findSummaryMetadata(DETAIL_2026_07_09, endpoint).template).toBe(
			'Adaptive Summary',
		);
	});

	it('scopes category to aiContentHeader, not industry_category / original_category / per-question category', () => {
		expect(findSummaryMetadata(DETAIL_2026_07_09, endpoint).category).toBe(
			'Adaptive Summary',
		);
	});

	it('resolves industry_category separately from category, even when category mirrors the template name', () => {
		const distinct = {
			data: {
				content_list: [
					{
						data_type: 'auto_sum_note',
						extra: {
							used_template: {
								template_name: 'Deep Summary Transcript',
							},
						},
					},
				],
				extra_data: {
					model: 'gpt-5.5',
					aiContentHeader: {
						category: 'Deep Summary Transcript',
						industry_category: 'Healthcare',
					},
				},
			},
		};
		const md = findSummaryMetadata(distinct, endpoint);
		expect(md.template).toBe('Deep Summary Transcript');
		expect(md.category).toBe('Deep Summary Transcript');
		expect(md.industry).toBe('Healthcare');
	});

	it('omits industry when aiContentHeader has no industry_category', () => {
		const noIndustry = {
			data: {
				content_list: [
					{
						data_type: 'auto_sum_note',
						extra: { summ_type: 'meeting' },
					},
				],
				extra_data: {
					model: 'gpt-5.5',
					aiContentHeader: { headline: 'H', category: 'Meeting' },
				},
			},
		};
		expect(
			findSummaryMetadata(noIndustry, endpoint).industry,
		).toBeUndefined();
	});

	it('does not bleed category into a nested per-question category when the header lacks a direct one', () => {
		const noDirectCategory = {
			data: {
				content_list: [
					{
						data_type: 'auto_sum_note',
						extra: { summ_type: 'meeting' },
					},
				],
				extra_data: {
					model: 'gpt-5.5',
					aiContentHeader: {
						headline: 'A headline',
						// no direct `category`, but recommend_questions each carry one
						recommend_questions: [
							{ category: 'key_insights' },
							{ category: 'subtext' },
						],
					},
				},
			},
		};
		const md = findSummaryMetadata(noDirectCategory, endpoint);
		expect(md.category).toBeUndefined();
		expect(md.headline).toBe('A headline');
	});

	it('falls back to summ_type when no template_name is present', () => {
		const noTemplateName = {
			data: {
				content_list: [
					{
						data_type: 'auto_sum_note',
						extra: { summ_type: 'meeting' },
					},
				],
				extra_data: { model: 'gpt-5.5' },
			},
		};
		const md = findSummaryMetadata(noTemplateName, endpoint);
		expect(md.template).toBe('meeting');
		expect(md.model).toBe('gpt-5.5');
	});

	it('resolves language from extra_data when Plaud includes it, alongside the other fields', () => {
		const withLanguage = {
			data: {
				content_list: [
					{
						data_type: 'auto_sum_note',
						extra: {
							summ_type: 'meeting',
							used_template: { template_name: 'Meeting Notes' },
						},
					},
				],
				extra_data: {
					model: 'gpt-5.5',
					language: 'en',
					aiContentHeader: { headline: 'H', category: 'Meeting' },
				},
			},
		};
		const md = findSummaryMetadata(withLanguage, endpoint);
		expect(md.language).toBe('en');
		expect(md.template).toBe('Meeting Notes');
		expect(md.model).toBe('gpt-5.5');
	});

	it('returns {} when the summary metadata subtrees are absent (older recording)', () => {
		const bare = { data: { file_id: 'x', content_list: [] } };
		expect(findSummaryMetadata(bare, endpoint)).toEqual({});
	});

	it('throws on a structurally invalid response (no data envelope)', () => {
		expect(() => findSummaryMetadata({ status: 0 }, endpoint)).toThrow();
	});
});
