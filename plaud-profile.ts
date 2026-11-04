import type { ServiceProfile } from './service-profile';

export const PLAUD_PROFILE: ServiceProfile = {
	keyPrefix: 'plaud',
	pluginId: 'plaud-importer',
	/**
	 * The v4 portal preserves each v3 recording's id and exposes it as
	 * `of_<v3id>`, so a note that stored the bare v3 id (`<v3id>`) and the
	 * current v4 recording (`of_<v3id>`) are the same meeting. Stripping the
	 * single leading `of_` makes them equal. v4-native ids (`f_...`, `f_s_...`)
	 * carry no v3 id and are returned unchanged. Pure and total.
	 */
	canonicalId: (id) => (id.startsWith('of_') ? id.slice(3) : id),
};
