(function() {
    window.otareeAuthHeaders = {};
    window.otareeLastSearchUrl = null;
    window.otareeLastSearchMethod = 'GET';
    window.otareeLastSearchBody = null;

    // Capture du refresh_token Otaree — mécanisme indépendant de l'auth Hubiflow (autre
    // extension, autre destination). Le refresh se redéclenche automatiquement toutes les
    // ~5 minutes tant que l'onglet reste ouvert, donc plusieurs occasions de le capter.
    let dernierRefreshTokenEnvoye = null;
    function captureRefreshToken(body) {
        if (!body) return;
        try {
            const parsed = typeof body === 'string' ? JSON.parse(body) : body;
            const refreshToken = parsed && parsed.refresh_token;
            if (refreshToken && refreshToken !== dernierRefreshTokenEnvoye) {
                dernierRefreshTokenEnvoye = refreshToken;
                window.postMessage({
                    source: 'otaree-scraper',
                    type: 'REFRESH_TOKEN_CAPTURED',
                    refreshToken,
                    device: parsed.device || null,
                    instanceId: window.otareeAuthHeaders['X-Instance-Id'] || null
                }, '*');
            }
        } catch (e) {
            // Body pas du JSON exploitable — on ignore, pas critique.
        }
    }

    function captureDataFromUrlAndHeaders(method, url, headers, body) {
        if (!url || typeof url !== 'string') return;

        if (url.includes('api.link-app.immo')) {
            if (headers) {
                if (headers.has('Authorization') || headers.has('authorization')) {
                    window.otareeAuthHeaders['Authorization'] = headers.get('Authorization') || headers.get('authorization');
                }
                if (headers.has('Accept')) window.otareeAuthHeaders['Accept'] = headers.get('Accept');
                if (headers.has('Content-Type')) window.otareeAuthHeaders['Content-Type'] = headers.get('Content-Type');
                if (headers.has('X-Instance-Id')) window.otareeAuthHeaders['X-Instance-Id'] = headers.get('X-Instance-Id');
            }
            if (url.includes('estate/properties.jsonld') || url.includes('estate_searches')) {
                if (url.includes('estate/properties.jsonld')) {
                    window.otareeLastSearchUrl = url;
                    window.otareeLastSearchMethod = method || 'GET';
                    window.otareeLastSearchBody = body || null;
                }
            }
            if (url.includes('security/refresh-token')) {
                captureRefreshToken(body);
            }
        }
    }

    const originalFetch = window.fetch;
    window.fetch = async function(...args) {
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
        const options = args[1] || {};
        const method = options.method || 'GET';
        const body = options.body;
        
        if (options.headers) {
            captureDataFromUrlAndHeaders(method, url, new Headers(options.headers), body);
        } else {
            captureDataFromUrlAndHeaders(method, url, null, body);
        }
        
        return await originalFetch.apply(this, args);
    };
    
    const XHR = XMLHttpRequest.prototype;
    const open = XHR.open;
    const send = XHR.send;
    const setRequestHeader = XHR.setRequestHeader;

    XHR.open = function(method, url) {
        this._method = method;
        this._url = url;
        this._headers = new Headers();
        return open.apply(this, arguments);
    };

    XHR.setRequestHeader = function(header, value) {
        this._headers.append(header, value);
        return setRequestHeader.apply(this, arguments);
    };

    XHR.send = function(postData) {
        captureDataFromUrlAndHeaders(this._method, this._url, this._headers, postData);
        return send.apply(this, arguments);
    };
    
    window.otareeScrapePaused = false;
    window.otareeScrapeActive = false;

    window.addEventListener('message', function(e) {
        if (e.source !== window || !e.data) return;
        if (e.data.type === 'PAUSE_SCRAPE') {
            window.otareeScrapePaused = true;
        } else if (e.data.type === 'RESUME_SCRAPE') {
            window.otareeScrapePaused = false;
        } else if (e.data.type === 'TOGGLE_PAUSE_SCRAPE') {
            window.otareeScrapePaused = !window.otareeScrapePaused;
        }
    });

    async function checkPauseStatus(lastMessage, lastPercent) {
        while (window.otareeScrapePaused) {
            window.postMessage({ 
                source: 'otaree-scraper', 
                type: 'SCRAPE_PAUSED', 
                message: lastMessage ? `⏸ En pause (${lastMessage})` : '⏸ Extraction en pause', 
                percent: lastPercent 
            }, '*');
            await new Promise(r => setTimeout(r, 200));
        }
    }
    
    window.addEventListener('message', async function(e) {
        if (e.source !== window || !e.data || e.data.type !== 'START_SCRAPE') return;
        
        try {
            if (!window.otareeLastSearchUrl) {
                throw new Error("Veuillez d'abord lancer une recherche sur la page (Rafraîchissez la page et refaites la recherche).");
            }

            window.otareeScrapePaused = false;
            window.otareeScrapeActive = true;

            window.postMessage({ source: 'otaree-scraper', type: 'SCRAPE_PROGRESS', message: 'Démarrage du scraping...', percent: 5 }, '*');
            
            const baseUrl = 'https://api.link-app.immo';
            let currentUrl = window.otareeLastSearchUrl;
            let allLots = [];
            let seenIds = new Set();
            let loopCount = 0;
            
            while (currentUrl && loopCount < 50) {
                await checkPauseStatus(`lots uniques: ${allLots.length}`, 15);
                loopCount++;
                window.postMessage({ source: 'otaree-scraper', type: 'SCRAPE_PROGRESS', message: `Récupération de la liste (lots uniques: ${allLots.length})...`, percent: 15 }, '*');
                
                let fetchOptions = {
                    method: window.otareeLastSearchMethod,
                    headers: window.otareeAuthHeaders
                };
                
                let body = window.otareeLastSearchBody;
                if (body && window.otareeLastSearchMethod !== 'GET') {
                    try {
                        let jsonBody = JSON.parse(body);
                        let match = currentUrl.match(/page=(\d+)/);
                        if (match) {
                            jsonBody.page = parseInt(match[1]);
                        }
                        fetchOptions.body = JSON.stringify(jsonBody);
                    } catch(err) {
                        fetchOptions.body = body;
                    }
                }

                const res = await originalFetch(currentUrl, fetchOptions);
                if (!res.ok) {
                    if (res.status === 401 || res.status === 403) {
                        throw new Error("Erreur d'authentification : Veuillez rafraîchir la page (F5) et refaire une recherche.");
                    }
                    throw new Error(`Erreur serveur (${res.status}).`);
                }
                
                const data = await res.json();
                let addedNewItems = false;
                
                if (data['hydra:member']) {
                    for (let item of data['hydra:member']) {
                        if (!seenIds.has(item['@id'])) {
                            seenIds.add(item['@id']);
                            allLots.push(item);
                            addedNewItems = true;
                        }
                    }
                }
                
                if (!addedNewItems) break;
                
                if (data['hydra:view'] && data['hydra:view']['hydra:next']) {
                    currentUrl = baseUrl + data['hydra:view']['hydra:next'];
                } else {
                    currentUrl = null;
                }
            }
            
            if (allLots.length === 0) {
                 throw new Error("Aucun lot trouvé. Avez-vous bien fait une recherche ?");
            }

            const CHUNK_SIZE = 30;
            const enrichedLots = [];
            
            for (let i = 0; i < allLots.length; i += CHUNK_SIZE) {
                const chunk = allLots.slice(i, i + CHUNK_SIZE);
                let percent = 20 + Math.round((i / allLots.length) * 80);
                const lotMsg = `Extraction des lots ${i + 1} à ${Math.min(i + CHUNK_SIZE, allLots.length)} / ${allLots.length}`;
                
                await checkPauseStatus(lotMsg, percent);
                window.postMessage({ source: 'otaree-scraper', type: 'SCRAPE_PROGRESS', message: `${lotMsg}...`, percent: percent }, '*');
                
                const chunkResults = await Promise.all(chunk.map(async (lot) => {
                    try {
                        const detailRes = await originalFetch(baseUrl + lot['@id'], {
                            method: 'GET',
                            headers: window.otareeAuthHeaders
                        });
                        if (detailRes.ok) {
                            const detailData = await detailRes.json();
                            lot.documents = detailData.documents || [];
                            lot.images = detailData.images || [];
                            lot.plan = detailData.plan || null;
                        }

                        if (lot.program && lot.program['@id']) {
                            const progRes = await originalFetch(baseUrl + lot.program['@id'], {
                                method: 'GET',
                                headers: window.otareeAuthHeaders
                            });
                            if (progRes.ok) {
                                const progData = await progRes.json();
                                if (progData.documents && progData.documents.length > 0) {
                                    lot.documents = lot.documents.concat(progData.documents);
                                }
                                if (progData.images && progData.images.length > 0) {
                                    lot.images = lot.images.concat(progData.images);
                                }
                                if (progData.perspective) {
                                    lot.images.push(progData.perspective);
                                }
                            }
                        }
                    } catch (err) {
                        console.error("Error fetching lot/program details", lot['@id'], err);
                    }
                    return lot;
                }));
                
                enrichedLots.push(...chunkResults);
            }
            
            window.otareeScrapeActive = false;
            window.postMessage({ source: 'otaree-scraper', type: 'SCRAPE_DONE', data: enrichedLots, searchUrl: window.otareeLastSearchUrl }, '*');
            
        } catch (error) {
            window.otareeScrapeActive = false;
            console.error("Scrape Error", error);
            window.postMessage({ source: 'otaree-scraper', type: 'SCRAPE_ERROR', message: error.message }, '*');
        }
    });
})();
