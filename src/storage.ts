import Apify from 'apify';
import { AsyncMap } from 'async-atomic-store';
import type { FbPage } from './definitions';

const { log } = Apify.utils;

export const emptyState = (): FbPage => ({
    categories: [],
    info: [],
    likes: 0,
    messenger: '',
    posts: [],
    priceRange: '',
    title: '',
    pageUrl: '',
    address: {
        city: null,
        lat: null,
        lng: null,
        postalCode: null,
        region: null,
        street: null,
    },
    awards: [],
    email: null,
    impressum: [],
    instagram: null,
    phone: null,
    products: [],
    transit: null,
    twitter: null,
    website: null,
    youtube: null,
    mission: [],
    overview: [],
    payment: null,
    checkins: '',
    '#startedAt': new Date().toISOString(),
    verified: false,
});

/**
 * Persist the crawl state that can survive
 * migrations. Can persist manually if needed.
 *
 * `map` provides a way to write to deep paths in
 * complex objects while still being able to be
 * written asynchronously from many sources, while dealing
 * with racing conditions
 */
export const statePersistor = async () => {
    const kv = await Apify.openKeyValueStore();

    const state = new Map<string, Partial<FbPage>>(
        await kv.getValue('STATE') as any,
    );

    const map = AsyncMap(state);

    const persistState = async () => {
        log.info('Persisting to STATE.json...');

        await kv.setValue('STATE', [...state]);
    };

    Apify.events.on('persistState', persistState);

    return {
        persistState,
        state,
        map,
    };
};
