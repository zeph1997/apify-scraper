import Apify from 'apify';
import { InfoError } from './error';
import { LABELS, CSS_SELECTORS } from './constants';
import {
    getUrlLabel,
    setLanguageCodeToCookie,
    userAgents,
    normalizeOutputPageUrl,
    extractUsernameFromUrl,
    generateSubpagesFromUrl,
    stopwatch,
    executeOnDebug,
    storyFbToDesktopPermalink,
    proxyConfiguration,
    minMaxDates,
    resourceCache,
} from './functions';
import {
    getPagesFromListing,
    getPageInfo,
    getPostUrls,
    getFieldInfos,
    getReviews,
    getPostContent,
    getPostComments,
    getServices,
    getPostInfoFromScript,
    isNotFoundPage,
} from './page';
import { statePersistor, emptyState } from './storage';
import type { Schema, FbLabel, FbSection, FbPage } from './definitions';

import LANGUAGES = require('./languages.json');

const { log, puppeteer } = Apify.utils;

Apify.main(async () => {
    const input: Schema | null = await Apify.getInput() as any;

    if (!input || typeof input !== 'object') {
        throw new Error('Missing input');
    }

    const {
        startUrls,
        maxPosts = 3,
        maxPostDate,
        minPostDate,
        maxPostComments = 15,
        maxReviewDate,
        maxCommentDate,
        maxReviews = 3,
        commentsMode = 'RANKED_THREADED',
        scrapeAbout = true,
        scrapeReviews = true,
        scrapePosts = true,
        scrapeServices = true,
        language = 'en-US',
        sessionStorage = '',
        useStealth = false,
        debugLog = false,
        minPostComments,
        minPosts,
    } = input;

    if (debugLog) {
        log.setLevel(log.LEVELS.DEBUG);
    }

    if (!Array.isArray(startUrls) || !startUrls.length) {
        throw new Error('You must provide the "startUrls" input');
    }

    if (!Number.isFinite(maxPostComments)) {
        throw new Error('You must provide a finite number for "maxPostComments" input');
    }

    const proxyConfig = await proxyConfiguration({
        proxyConfig: input.proxyConfiguration,
        hint: ['RESIDENTIAL'],
        required: true,
    });

    if (Apify.isAtHome() && !proxyConfig?.groups?.includes('RESIDENTIAL')) {
        log.warning(`!!!!!!!!!!!!!!!!!!!!!!!\n\nYou're not using RESIDENTIAL proxy group, it won't work as expected. Contact support@apify.com or on Intercom to give you proxy trial\n\n!!!!!!!!!!!!!!!!!!!!!!!`);
    }

    let handlePageTimeoutSecs = Math.round(60 * (((maxPostComments + maxPosts) || 10) * 0.03)) + 600; // minimum 600s

    if (handlePageTimeoutSecs * 60000 >= 0x7FFFFFFF) {
        log.warning(`maxPosts + maxPostComments parameter is too high, must be less than ${0x7FFFFFFF} milliseconds in total, got ${handlePageTimeoutSecs * 60000}. Loading posts and comments might never finish or crash the scraper at any moment.`, {
            maxPostComments,
            maxPosts,
            handlePageTimeoutSecs,
            handlePageTimeout: handlePageTimeoutSecs * 60000,
        });
        handlePageTimeoutSecs = Math.floor(0x7FFFFFFF / 60000);
    }

    log.info(`Will use ${handlePageTimeoutSecs}s timeout for page`);

    const startUrlsRequests = new Apify.RequestList({
        sources: startUrls,
    });

    await startUrlsRequests.initialize();

    if (!(language in LANGUAGES)) {
        throw new Error(`Selected language "${language}" isn't supported`);
    }

    const { map, state, persistState } = await statePersistor();
    const elapsed = stopwatch();

    log.info(`Starting crawler with ${startUrlsRequests.length()} urls`);
    log.info(`Using language "${(LANGUAGES as any)[language]}" (${language})`);

    const postDate = minMaxDates({
        max: minPostDate,
        min: maxPostDate,
    });

    if (scrapePosts) {
        if (postDate.maxDate) {
            log.info(`\n-------\n\nGetting posts from ${postDate.maxDate.toLocaleString()} and older\n\n-------`);
        }

        if (postDate.minDate) {
            log.info(`\n-------\n\nGetting posts from ${postDate.minDate.toLocaleString()} and newer\n\n-------`);
        }
    }

    const commentDate = minMaxDates({
        min: maxCommentDate,
    });

    if (commentDate.minDate) {
        log.info(`Getting comments from ${commentDate.minDate.toLocaleString()} and newer`);
    }

    const reviewDate = minMaxDates({
        min: maxReviewDate,
    });

    if (reviewDate.minDate) {
        log.info(`Getting reviews from ${reviewDate.minDate.toLocaleString()} and newer`);
    }

    const requestQueue = await Apify.openRequestQueue();

    let nextRequest;
    const processedRequests = new Set<Apify.Request>();

    // eslint-disable-next-line no-cond-assign
    while (nextRequest = await startUrlsRequests.fetchNextRequest()) {
        processedRequests.add(nextRequest);
    }

    if (!processedRequests.size) {
        throw new Error('No requests were loaded from startUrls');
    }

    const initSubPage = async (subpage: { url: string; section: FbSection, useMobile: boolean }, url: string) => {
        if (subpage.section === 'home') {
            const username = extractUsernameFromUrl(subpage.url);

            // initialize the page. if it's already initialized,
            // use the current content
            await map.append(username, async (value) => {
                return {
                    ...emptyState(),
                    pageUrl: normalizeOutputPageUrl(subpage.url),
                    '#url': subpage.url,
                    '#ref': url,
                    ...value,
                };
            });
        }

        await requestQueue.addRequest({
            url: subpage.url,
            userData: {
                label: LABELS.PAGE,
                sub: subpage.section,
                ref: url,
                useMobile: subpage.useMobile,
            },
        }, { forefront: true });
    };

    const pageInfo = [
        ...(scrapePosts ? ['posts'] : []),
        ...(scrapeAbout ? ['about'] : []),
        ...(scrapeReviews ? ['reviews'] : []),
        ...(scrapeServices ? ['services'] : []),
    ] as FbSection[];

    for (const request of processedRequests) {
        try {
            const { url } = request;
            const urlType = getUrlLabel(url);

            if (urlType === LABELS.PAGE) {
                for (const subpage of generateSubpagesFromUrl(url, pageInfo)) {
                    await initSubPage(subpage, url);
                }
            } else if (urlType === LABELS.LISTING) {
                await requestQueue.addRequest({
                    url,
                    userData: {
                        label: urlType,
                        useMobile: false,
                    },
                });
            } else if (urlType === LABELS.POST) {
                const username = extractUsernameFromUrl(url);

                await requestQueue.addRequest({
                    url,
                    userData: {
                        label: LABELS.POST,
                        useMobile: false,
                        username,
                        canonical: storyFbToDesktopPermalink(url)?.toString(),
                    },
                });

                // this is for home
                await initSubPage(generateSubpagesFromUrl(url, [])[0], url);
            }
        } catch (e) {
            if (e instanceof InfoError) {
                // We want to inform the rich error before throwing
                log.warning(`------\n\n${e.message}\n\n------`, e.toJSON());
            } else {
                throw e;
            }
        }
    }

    const maxConcurrency = process.env?.MAX_CONCURRENCY ? +process.env.MAX_CONCURRENCY : undefined;
    const cache = resourceCache([
        /rsrc\.php/,
    ]);

    const crawler = new Apify.PuppeteerCrawler({
        requestQueue,
        useSessionPool: true,
        sessionPoolOptions: {
            persistStateKeyValueStoreId: sessionStorage || undefined,
            maxPoolSize: sessionStorage ? 1 : undefined,
        },
        maxRequestRetries: 5,
        maxConcurrency,
        proxyConfiguration: proxyConfig,
        launchContext: {
            stealth: useStealth,
            launchOptions: {
                devtools: debugLog,
                useIncognitoPages: true,
            },
        },
        browserPoolOptions: {
            maxOpenPagesPerBrowser: maxConcurrency,
        },
        persistCookiesPerSession: sessionStorage !== '',
        handlePageTimeoutSecs, // more comments, less concurrency
        preNavigationHooks: [async ({ page, request }, gotoOptions) => {
            gotoOptions.waitUntil = 'domcontentloaded';
            gotoOptions.timeout = 60000;

            await setLanguageCodeToCookie(language, page);

            await executeOnDebug(async () => {
                await page.exposeFunction('logMe', (...args) => {
                    console.log(...args); // eslint-disable-line no-console
                });
            });

            await page.exposeFunction('unhideChildren', (element?: HTMLElement) => {
                // weird bugs happen in this function, sometimes the dom element has no querySelectorAll for
                // unknown reasons
                if (!element) {
                    return;
                }

                element.className = '';
                if (typeof element.removeAttribute === 'function') {
                    // weird bug that sometimes removeAttribute isn't a function?
                    element.removeAttribute('style');
                }

                if (typeof element.querySelectorAll === 'function') {
                    for (const el of [...element.querySelectorAll<HTMLElement>('*')]) {
                        el.className = ''; // removing the classes usually unhides

                        if (typeof element.removeAttribute === 'function') {
                            el.removeAttribute('style');
                        }
                    }
                }
            });

            await cache(page);

            // make the page a little more lightweight
            await puppeteer.blockRequests(page, {
                urlPatterns: [
                    '.woff',
                    '.webp',
                    '.mov',
                    '.mpeg',
                    '.mpg',
                    '.mp4',
                    '.woff2',
                    '.ttf',
                    '.ico',
                    'scontent-',
                    'scontent.fplu',
                    'safe_image.php',
                    'static_map.php',
                    'ajax/bz',
                ],
            });

            const { userData: { useMobile } } = request;

            // listing need to start in a desktop version
            // page needs a mobile viewport
            const { data } = useMobile
                ? userAgents.mobile()
                : userAgents.desktop();

            request.userData.userAgent = data.userAgent;

            await page.emulate({
                userAgent: data.userAgent,
                viewport: {
                    height: useMobile ? 740 : 1080,
                    width: useMobile ? 360 : 1920,
                    hasTouch: useMobile,
                    isMobile: useMobile,
                    deviceScaleFactor: useMobile ? 2 : 1,
                },
            });

            await page.evaluateOnNewDocument(() => {
                const f = () => {
                    for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-testid="cookie-policy-dialog-accept-button"]')) {
                        if (btn) {
                            btn.click();
                        }
                    }
                    setTimeout(f, 1000);
                };
                setTimeout(f);
            });
        }],
        handlePageFunction: async ({ request, page, session }) => {
            const { userData } = request;

            const label: FbLabel = userData.label; // eslint-disable-line prefer-destructuring

            log.debug(`Visiting page ${request.url}`);

            try {
                if (page.url().includes('?next=')) {
                    throw new InfoError(`Content needs login to work, this will be retried but most likely won't work as expected`, {
                        url: request.url,
                        namespace: 'login',
                        userData,
                    });
                }

                if (userData.useMobile) {
                    // need to do some checks if the current mobile page is the interactive one or if
                    // it has been blocked
                    if (await page.$(CSS_SELECTORS.MOBILE_CAPTCHA)) {
                        throw new InfoError('Mobile captcha found', {
                            url: request.url,
                            namespace: 'captcha',
                            userData,
                        });
                    }

                    try {
                        await Promise.all([
                            page.waitForSelector(CSS_SELECTORS.MOBILE_META, {
                                timeout: 3000, // sometimes the page takes a while to load the responsive interactive version
                            }),
                            page.waitForSelector(CSS_SELECTORS.MOBILE_BODY_CLASS, {
                                timeout: 3000, // correctly detected android. if this isn't the case, the image names will change
                            }),
                        ]);
                    } catch (e) {
                        throw new InfoError('An unexpected page layout was returned by the server. This request will be retried shortly.', {
                            url: request.url,
                            namespace: 'mobile-meta',
                            userData,
                        });
                    }
                }

                if (!userData.useMobile && await page.$(CSS_SELECTORS.DESKTOP_CAPTCHA)) {
                    throw new InfoError('Desktop captcha found', {
                        url: request.url,
                        namespace: 'captcha',
                        userData,
                    });
                }

                if (await page.$eval('title', (el) => el.textContent === 'Error')) {
                    throw new InfoError('Facebook internal error, maybe it\'s going through instability, it will be retried', {
                        url: request.url,
                        namespace: 'internal',
                        userData,
                    });
                }

                if (label !== LABELS.LISTING && label !== LABELS.POST && await isNotFoundPage(page)) {
                    request.noRetry = true;

                    // throw away if page is not available
                    // but inform the user of error
                    throw new InfoError('Content not found. This either means the page doesn\'t exist, or the section itself doesn\'t exist (about, reviews, services)', {
                        url: request.url,
                        namespace: 'isNotFoundPage',
                        userData,
                    });
                }

                if (label === LABELS.LISTING) {
                    const start = stopwatch();
                    const pagesUrls = await getPagesFromListing(page);

                    for (const url of pagesUrls) {
                        for (const subpage of generateSubpagesFromUrl(url, pageInfo)) {
                            await initSubPage(subpage, request.url);
                        }
                    }

                    log.info(`Got ${pagesUrls.size} pages from listing in ${start() / 1000}s`);
                } else if (userData.label === LABELS.PAGE) {
                    const username = extractUsernameFromUrl(request.url);

                    switch (userData.sub) {
                        // Main landing page
                        case 'home':
                            await map.append(username, async (value) => {
                                const {
                                    likes,
                                    messenger,
                                    title,
                                    verified,
                                    ...address
                                } = await getPageInfo(page);

                                return getFieldInfos(page, {
                                    ...value,
                                    likes,
                                    messenger,
                                    title,
                                    verified,
                                    address: {
                                        lat: null,
                                        lng: null,
                                        ...value?.address,
                                        ...address,
                                    },
                                });
                            });
                            break;
                        // Services if any
                        case 'services':
                            try {
                                const services = await getServices(page);

                                if (services.length) {
                                    await map.append(username, async (value) => {
                                        return {
                                            ...value,
                                            services: [
                                                ...(value?.services ?? []),
                                                ...services,
                                            ],
                                        };
                                    });
                                }
                            } catch (e) {
                                // it's ok to fail here, not every page has services
                                log.debug(e.message);
                            }
                            break;
                        // About if any
                        case 'about':
                            await map.append(username, async (value) => {
                                return getFieldInfos(page, {
                                    ...value,
                                });
                            });
                            break;
                        // Posts
                        case 'posts': {
                            // We don't do anything here, we enqueue posts to be
                            // read on their own phase/label
                            const postCount = await getPostUrls(page, {
                                max: maxPosts,
                                date: postDate,
                                username,
                                requestQueue,
                                request,
                                minPosts,
                            });

                            if (maxPosts && minPosts && postCount < minPosts) {
                                throw new InfoError(`Minimum post count of ${minPosts} not met, retrying...`, {
                                    namespace: 'threshold',
                                    url: page.url(),
                                });
                            }

                            break;
                        }
                        // Reviews if any
                        case 'reviews':
                            try {
                                const reviewsData = await getReviews(page, {
                                    max: maxReviews,
                                    date: reviewDate,
                                    request,
                                });

                                if (reviewsData) {
                                    const { average, count, reviews } = reviewsData;

                                    await map.append(username, async (value) => {
                                        return {
                                            ...value,
                                            reviews: {
                                                ...(value?.reviews ?? {}),
                                                average,
                                                count,
                                                reviews: [
                                                    ...reviews,
                                                    ...(value?.reviews?.reviews ?? []),
                                                ],
                                            },
                                        };
                                    });
                                }
                            } catch (e) {
                                // it's ok for failing here, not every page has reviews
                                log.debug(e.message);
                            }
                            break;
                        // make eslint happy
                        default:
                            throw new InfoError(`Unknown subsection ${userData.sub}`, {
                                url: request.url,
                                namespace: 'handlePageFunction',
                            });
                    }
                } else if (label === LABELS.POST) {
                    const postTimer = stopwatch();

                    log.debug('Started processing post', { url: request.url });

                    // actually parse post content here, it doesn't work on
                    // mobile address
                    const { username, canonical } = userData;

                    const [postStats, content] = await Promise.all([
                        getPostInfoFromScript(page, canonical),
                        getPostContent(page),
                    ]);

                    const postComments = await getPostComments(page, {
                        max: maxPostComments,
                        mode: commentsMode,
                        date: commentDate,
                        request,
                        minPostComments,
                    });

                    await map.append(username, async (value) => {
                        return {
                            ...value,
                            posts: [
                                {
                                    ...content,
                                    postStats,
                                    postComments,
                                },
                                ...(value?.posts ?? []),
                            ],
                        } as Partial<FbPage>;
                    });

                    if (maxPostComments && minPostComments && (postComments?.comments?.length ?? 0) < minPostComments) {
                        throw new InfoError(`Minimum post count ${minPostComments} not met, retrying`, {
                            namespace: 'threshold',
                            url: page.url(),
                        });
                    }

                    log.info(`Processed post in ${postTimer() / 1000}s`, { url: request.url });
                }
            } catch (e) {
                log.debug(e.message, {
                    url: request.url,
                    userData: request.userData,
                    error: e,
                });

                if (e instanceof InfoError) {
                    // We want to inform the rich error before throwing
                    log.warning(e.message, e.toJSON());

                    if (['captcha', 'mobile-meta', 'getFieldInfos', 'internal', 'login', 'threshold'].includes(e.meta.namespace)) {
                        // the session is really bad
                        session?.retire();
                    }
                }

                throw e;
            }

            log.debug(`Done with page ${request.url}`);
        },
        handleFailedRequestFunction: async ({ request, error }) => {
            if (error instanceof InfoError) {
                // this only happens when maxRetries is
                // comprised mainly of InfoError, which is usually a problem
                // with pages
                log.exception(error, 'handleFailedRequestFunction', error.toJSON());
            } else {
                log.error(`Requests failed on ${request.url} after ${request.retryCount} retries`);
            }
        },
    });

    await crawler.run();

    await persistState();

    log.info('Generating dataset...');

    const finished = new Date().toISOString();

    // generate the dataset from all the crawled pages
    await Apify.pushData([...state.values()].filter(s => s.categories?.length).map(val => ({
        ...val,
        "#version": 3, // current data format version
        '#finishedAt': finished,
    })));

    log.info(`Done in ${Math.round(elapsed() / 60000)}m!`);
});
